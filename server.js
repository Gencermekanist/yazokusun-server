// server.js  ✨ TAM SÜRÜM ✨
//
// Ortam değişkenleri:
//   FIREBASE_SA_JSON      → Firebase Admin SDK servis hesabı JSON
//   GOOGLE_APPLICATION_CREDENTIALS → Yol olarak Render Secret File (`/etc/secrets/tts-service-account.json`)
//   REFRESH_MINUTES       → Remote Config’i kaç dakikada bir yenilesin (isteğe bağlı)

const express       = require('express');
const fs            = require('fs');
const path          = require('path');
const util          = require('util');
const textToSpeech  = require('@google-cloud/text-to-speech');
const bodyParser    = require('body-parser');
const cors          = require('cors');
const admin         = require('firebase-admin');

// ─────────────────────────────────────────────────────────────
// 1) Firebase Admin başlat
// ─────────────────────────────────────────────────────────────
const fbCred = JSON.parse(process.env.FIREBASE_SA_JSON);
admin.initializeApp({
  credential: admin.credential.cert(fbCred),
});
const db = admin.firestore();

// Remote Config şablonunu bellekte tutacağız
let remoteConfig = { daily_free_chars: 2000 };
async function refreshRemoteConfig() {
  try {
    const tmpl = await admin.remoteConfig().getTemplate();
    remoteConfig.daily_free_chars =
      parseInt(tmpl.parameters['daily_free_chars']?.defaultValue?.value ?? 2000);
    console.log('🔄 Remote Config yenilendi:', remoteConfig);
  } catch (e) {
    console.error('⚠️  Remote Config okunamadı, varsayılanlar kullanılıyor', e);
  }
}
// Sunucu başlarken ve her X dakikada bir yenile
refreshRemoteConfig();
setInterval(
  refreshRemoteConfig,
  (parseInt(process.env.REFRESH_MINUTES || '10', 10) || 10) * 60 * 1000
);

// ─────────────────────────────────────────────────────────────
// 2) Google TTS istemcisi
// ─────────────────────────────────────────────────────────────
// Render’da Secret File olarak yüklenen `tts-service-account.json`
// ve Google Application Credentials ENV var ile otomatik okunacak.
const ttsClient = new textToSpeech.TextToSpeechClient();
// Alternatif olarak açıkça keyFilename belirtmek istersen:
// const ttsClient = new textToSpeech.TextToSpeechClient({
//   keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
// });

// ─────────────────────────────────────────────────────────────
// 3) Express ayarları
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Dil haritası (BCP-47)
const googleLangMap = {
  'ar-AR': 'ar-XA',
  'fa-IR': 'fa-IR',
  'tr-TR': 'tr-TR',
  'en-US': 'en-US',
  'de-DE': 'de-DE',
  'fr-FR': 'fr-FR',
  'es-ES': 'es-ES',
  'it-IT': 'it-IT',
  'pt-BR': 'pt-BR',
  'pt-PT': 'pt-PT',
};
// Fallback sesler
const fallbackVoices = {
  'es-ES': { FEMALE: 'es-ES-Standard-A', MALE: 'es-ES-Standard-B' },
};

// ─────────────────────────────────────────────────────────────
// 4) Yardımcı: cihaz başına günlük kullanım
// ─────────────────────────────────────────────────────────────
async function checkAndUpdateQuota(deviceId, textLen) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const doc   = db.collection('deviceUsage').doc(deviceId);
  const snap  = await doc.get();

  let used = 0;
  if (snap.exists && snap.data().day === today) {
    used = snap.data().used || 0;
  }

  const limit = remoteConfig.daily_free_chars;
  if (used + textLen > limit) return false;                // kota doldu

  await doc.set({ day: today, used: used + textLen }, { merge: true });
  return true;
}

// ─────────────────────────────────────────────────────────────
// 5) Ana endpoint – /synthesize
// ─────────────────────────────────────────────────────────────
app.post('/synthesize', async (req, res) => {
  let {
    text,
    gender      = 'FEMALE',
    languageCode= 'tr-TR',
    rate        = 1.0,
    voiceType   = 'WAVENET',
    textLen,                 // mobil taraf gönderiyor
    deviceId,                // mobil taraf gönderiyor
    isPlus = false,          // mobil taraf gönderiyor
  } = req.body;

  // Basit doğrulamalar
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Text is required.' });
  }
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId missing.' });
  }
  if (!textLen) {
    textLen = Buffer.byteLength(text, 'utf8');
  }

  // ── KOTA KONTROLÜ (Plus kullanıcı bypass) ──
  if (!isPlus) {
    const ok = await checkAndUpdateQuota(deviceId, textLen);
    if (!ok) {
      return res.status(429).json({ error: 'quotaExceeded' });
    }
  }

  // ── VoiceName seçimi ──
  const voiceLang = googleLangMap[languageCode] || languageCode;
  let voiceName;
  if (voiceType === 'WAVENET') {
    voiceName = `${voiceLang}-Wavenet-${gender === 'MALE' ? 'B' : 'D'}`;
  } else if (voiceType === 'NEURAL2') {
    voiceName = `${voiceLang}-Neural2-${gender === 'MALE' ? 'B' : 'D'}`;
  } else {
    voiceName = `${voiceLang}-Standard-${gender === 'MALE' ? 'B' : 'A'}`;
  }
  if (fallbackVoices[voiceLang]) {
    voiceName = fallbackVoices[voiceLang][gender];
  }

  const request = {
    input : { text },
    voice : { languageCode: voiceLang, ssmlGender: gender, name: voiceName },
    audioConfig: { audioEncoding: 'MP3', speakingRate: parseFloat(rate) },
  };

  try {
    const [response] = await ttsClient.synthesizeSpeech(request);
    const tmpFile = path.join(__dirname, `tmp_${Date.now()}.mp3`);
    await util.promisify(fs.writeFile)(tmpFile, response.audioContent, 'binary');

    res.sendFile(tmpFile, {}, (err) => {
      if (!err) setTimeout(() => fs.existsSync(tmpFile) && fs.unlinkSync(tmpFile), 5000);
    });
  } catch (e) {
    console.error('TTS Error:', e);
    res.status(500).json({ error: e.message || 'Google TTS failed.' });
  }
});

// ─────────────────────────────────────────────────────────────
// 6) Yardımcı endpoint – seçilen voice’ı görmek için
// ─────────────────────────────────────────────────────────────
app.get('/voice-info', (req, res) => {
  const gender    = req.query.gender    || 'FEMALE';
  const lang      = req.query.lang      || 'tr-TR';
  const voiceType = req.query.voiceType || 'WAVENET';

  const voiceLang = googleLangMap[lang] || lang;
  let voiceName;
  if (voiceType === 'WAVENET') {
    voiceName = `${voiceLang}-Wavenet-${gender === 'MALE' ? 'B' : 'D'}`;
  } else if (voiceType === 'NEURAL2') {
    voiceName = `${voiceLang}-Neural2-${gender === 'MALE' ? 'B' : 'D'}`;
  } else {
    voiceName = `${voiceLang}-Standard-${gender === 'MALE' ? 'B' : 'A'}`;
  }
  if (fallbackVoices[voiceLang]) voiceName = fallbackVoices[voiceLang][gender];

  res.json({ selectedVoice: voiceName, freeDailyLimit: remoteConfig.daily_free_chars });
});

// ─────────────────────────────────────────────────────────────
// 7) Sunucuyu çalıştır
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Google TTS Sunucusu çalışıyor → http://0.0.0.0:${PORT}`);
});

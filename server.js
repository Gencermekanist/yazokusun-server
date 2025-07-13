
// server.js  ✨ TEMİZLENMİŞ Wavenet SÜRÜM ✨
const express = require('express');
const fs = require('fs');
const path = require('path');
const util = require('util');
const textToSpeech = require('@google-cloud/text-to-speech');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');

// 1) Firebase Admin başlat
const fbCred = JSON.parse(process.env.FIREBASE_SA_JSON);
admin.initializeApp({ credential: admin.credential.cert(fbCred) });
const db = admin.firestore();

// Remote Config (karakter limiti)
let remoteConfig = { daily_free_chars: 2000 };
async function refreshRemoteConfig() {
  try {
    const tmpl = await admin.remoteConfig().getTemplate();
    remoteConfig.daily_free_chars = parseInt(tmpl.parameters['daily_free_chars']?.defaultValue?.value ?? 2000);
    console.log('🔄 Remote Config yenilendi:', remoteConfig);
  } catch (e) {
    console.error('⚠️ Remote Config okunamadı:', e);
  }
}
refreshRemoteConfig();
setInterval(refreshRemoteConfig, (parseInt(process.env.REFRESH_MINUTES || '10', 10)) * 60 * 1000);

// 2) Google TTS istemcisi
const ttsClient = new textToSpeech.TextToSpeechClient();

// 3) Express ayarları
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

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

// 4) Karakter kullanım kontrolü
async function checkAndUpdateQuota(deviceId, textLen) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = db.collection('deviceUsage').doc(deviceId);
  const snap = await doc.get();

  let used = 0;
  if (snap.exists && snap.data().day === today) {
    used = snap.data().used || 0;
  }

  const limit = remoteConfig.daily_free_chars;
  if (used + textLen > limit) return false;

  await doc.set({ day: today, used: used + textLen }, { merge: true });
  return true;
}

// 5) Ana endpoint
app.post('/synthesize', async (req, res) => {
  let {
    text,
    gender = 'FEMALE',
    languageCode = 'tr-TR',
    rate = 1.0,
    voiceType = 'WAVENET',
    textLen,
    deviceId,
    isPlus = false,
    saveMp3 = false,
  } = req.body;

  if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required.' });
  if (!deviceId) return res.status(400).json({ error: 'deviceId missing.' });
  if (!textLen) textLen = Buffer.byteLength(text, 'utf8');

  if (!isPlus && !saveMp3) {
    const ok = await checkAndUpdateQuota(deviceId, textLen);
    if (!ok) return res.status(429).json({ error: 'quotaExceeded' });
  }

  const voiceLang = googleLangMap[languageCode] || languageCode;
  const voiceName = `${voiceLang}-Wavenet-${gender === 'MALE' ? 'B' : 'D'}`;

  const request = {
    input: { text },
    voice: { languageCode: voiceLang, ssmlGender: gender, name: voiceName },
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

// 6) Yardımcı endpoint – seçilen voice
app.get('/voice-info', (req, res) => {
  const gender = req.query.gender || 'FEMALE';
  const lang = req.query.lang || 'tr-TR';
  const voiceLang = googleLangMap[lang] || lang;
  const voiceName = `${voiceLang}-Wavenet-${gender === 'MALE' ? 'B' : 'D'}`;
  res.json({ selectedVoice: voiceName, freeDailyLimit: remoteConfig.daily_free_chars });
});

// 7) Sunucuyu başlat
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Google TTS sunucusu çalışıyor → http://0.0.0.0:${PORT}`);
});

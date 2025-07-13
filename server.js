// server.js  — Seçenek B: Kota yönetimi tamamen server-side
const express = require('express');
const fs = require('fs');
const path = require('path');
const util = require('util');
const textToSpeech = require('@google-cloud/text-to-speech');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');

// — 1) Firebase Admin başlat
const fbCred = JSON.parse(process.env.FIREBASE_SA_JSON);
admin.initializeApp({ credential: admin.credential.cert(fbCred) });
const db = admin.firestore();

// — 2) Remote Config (karakter limitleri)
let remoteConfig = {
  weekly_free_chars: 2000,       // Haftalık ücretsiz kota
  monthly_free_chars: 8000,      // Aylık ücretsiz kota (4×haftalık)
  monthly_plus_chars: 500000     // Plus abone aylık kota
};
async function refreshRemoteConfig() {
  try {
    const tmpl = await admin.remoteConfig().getTemplate();
    remoteConfig.weekly_free_chars  = parseInt(tmpl.parameters['weekly_free_chars']?.defaultValue?.value  ?? remoteConfig.weekly_free_chars, 10);
    remoteConfig.monthly_free_chars = parseInt(tmpl.parameters['monthly_free_chars']?.defaultValue?.value ?? remoteConfig.monthly_free_chars, 10);
    remoteConfig.monthly_plus_chars = parseInt(tmpl.parameters['monthly_plus_chars']?.defaultValue?.value ?? remoteConfig.monthly_plus_chars, 10);
    console.log('🔄 Remote Config yenilendi:', remoteConfig);
  } catch (e) {
    console.error('⚠️ Remote Config okunamadı:', e);
  }
}
refreshRemoteConfig();
setInterval(refreshRemoteConfig, (parseInt(process.env.REFRESH_MINUTES || '10', 10)) * 60 * 1000);

// — 3) Yardımcı: Haftanın ilk gününü (Pazartesi) YYYY-MM-DD formatında döner
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  // Pazar = 0, diğer günler 1–6
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

// — 4) Kota kontrol ve güncelleme
async function checkAndUpdateQuota(deviceId, textLen, isPlus) {
  const now = new Date();
  const weekKey  = getWeekStart(now);
  const monthKey = now.toISOString().slice(0, 7); // "YYYY-MM"

  const docRef = db.collection('deviceUsage').doc(deviceId);
  const snap   = await docRef.get();
  const data   = snap.exists ? snap.data() : {};

  // Mevcut kullanımlar
  const weekUsed  = data.week === weekKey  ? (data.weekUsed  || 0) : 0;
  const monthUsed = data.month === monthKey ? (data.monthUsed || 0) : 0;

  // Limit aşımları
  if (isPlus) {
    // Plus kullanıcı: aylık kota
    if (monthUsed + textLen > remoteConfig.monthly_plus_chars) {
      return false;
    }
  } else {
    // Ücretsiz kullanıcı: haftalık ve aylık limit
    if (weekUsed  + textLen > remoteConfig.weekly_free_chars)  return false;
    if (monthUsed + textLen > remoteConfig.monthly_free_chars) return false;
  }

  // Güncellenmiş değerler
  const updateData = {
    week:      weekKey,
    weekUsed:  weekUsed  + textLen,
    month:     monthKey,
    monthUsed: monthUsed + textLen,
  };

  await docRef.set(updateData, { merge: true });
  return true;
}

// — 5) Express ayarları
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

// — 6) /synthesize endpoint
app.post('/synthesize', async (req, res) => {
  let {
    text,
    gender      = 'FEMALE',
    languageCode= 'tr-TR',
    rate        = 1.0,
    voiceType   = 'WAVENET',
    textLen,
    deviceId,
    isPlus      = false,
    saveMp3     = false,
  } = req.body;

  if (!text || !text.trim())       return res.status(400).json({ error: 'Text is required.' });
  if (!deviceId)                   return res.status(400).json({ error: 'deviceId missing.' });
  if (!textLen)                    textLen = Buffer.byteLength(text, 'utf8');

  // Kota kontrol ve güncelleme
  const ok = await checkAndUpdateQuota(deviceId, textLen, isPlus);
  if (!ok) return res.status(429).json({ error: 'quotaExceeded' });

  // TTS isteği
  const voiceLang = googleLangMap[languageCode] || languageCode;
  const voiceName = `${voiceLang}-Wavenet-${gender === 'MALE' ? 'B' : 'D'}`;
  const request   = {
    input:       { text },
    voice:       { languageCode: voiceLang, ssmlGender: gender, name: voiceName },
    audioConfig: { audioEncoding: 'MP3', speakingRate: parseFloat(rate) },
  };

  try {
    const [response] = await new textToSpeech.TextToSpeechClient().synthesizeSpeech(request);
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

// — 7) Kota bilgisi dönen endpoint
app.get('/voice-info', (req, res) => {
  const gender = req.query.gender || 'FEMALE';
  const lang   = req.query.lang    || 'tr-TR';
  res.json({
    selectedVoice: `${googleLangMap[lang] || lang}-Wavenet-${gender === 'MALE' ? 'B' : 'D'}`,
    weeklyFree:    remoteConfig.weekly_free_chars,
    monthlyFree:   remoteConfig.monthly_free_chars,
    monthlyPlus:   remoteConfig.monthly_plus_chars
  });
});

// — 8) Sunucuyu başlat
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Google TTS sunucusu çalışıyor → http://0.0.0.0:${PORT}`);
});

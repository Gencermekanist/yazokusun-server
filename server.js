// server.js  — Seçenek B: Kota yönetimi tamamen server-side
const express           = require('express');
const fs                = require('fs');
const path              = require('path');
const util              = require('util');
const textToSpeech      = require('@google-cloud/text-to-speech');
const bodyParser        = require('body-parser');
const cors              = require('cors');
const admin             = require('firebase-admin');

// — 1) Firebase Admin başlat
const fbCred = JSON.parse(process.env.FIREBASE_SA_JSON);
admin.initializeApp({ credential: admin.credential.cert(fbCred) });
const db = admin.firestore();

// — 2) Remote Config (karakter limitleri)
let remoteConfig = {
  weekly_free_chars:   2000,    // Haftalık ücretsiz kullanıcı kotası
  monthly_free_chars:  8000,    // Aylık ücretsiz (4×haftalık)
  monthly_plus_chars:  500000   // Plus aboneler için aylık kota
};

async function refreshRemoteConfig() {
  try {
    const tmpl = await admin.remoteConfig().getTemplate();
    remoteConfig.weekly_free_chars   = parseInt(
      tmpl.parameters['weekly_free_chars']?.defaultValue?.value  ?? remoteConfig.weekly_free_chars, 10
    );
    remoteConfig.monthly_free_chars  = parseInt(
      tmpl.parameters['monthly_free_chars']?.defaultValue?.value ?? remoteConfig.monthly_free_chars, 10
    );
    remoteConfig.monthly_plus_chars  = parseInt(
      tmpl.parameters['monthly_plus_chars']?.defaultValue?.value ?? remoteConfig.monthly_plus_chars, 10
    );
    console.log('🔄 Remote Config güncellendi:', remoteConfig);
  } catch (e) {
    console.error('⚠️ Remote Config okunamadı:', e);
  }
}
refreshRemoteConfig();
setInterval(
  refreshRemoteConfig,
  (parseInt(process.env.REFRESH_MINUTES || '10', 10) * 60 * 1000)
);

// — 3) Yardımcı: Haftanın Pazartesi gününü YYYY-MM-DD formatında döner
function getWeekStart(date) {
  const d   = new Date(date);
  const day = d.getDay();               // Pazar=0, Pazartesi=1, … Cumartesi=6
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);  // “YYYY-MM-DD”
}

// — 4) Kota kontrol ve güncelleme
async function checkAndUpdateQuota(deviceId, textLen, isPlus) {
  const now      = new Date();
  const weekKey  = getWeekStart(now);          // “YYYY-MM-DD”
  const monthKey = now.toISOString().slice(0,7);// “YYYY-MM”

  const docRef = db.collection('deviceUsage').doc(deviceId);
  const snap   = await docRef.get();
  const data   = snap.exists ? snap.data() : {};

  // Eğer hafta anahtarı aynı ise, o hafta yapılmış kullanım; değilse sıfır
  const usedThisWeek  = data.week  === weekKey  ? (data.weekUsed  || 0) : 0;
  // Eğer ay anahtarı aynı ise, o ay yapılmış kullanım; değilse sıfır
  const usedThisMonth = data.month === monthKey ? (data.monthUsed || 0) : 0;

  // Kota aşıldı mı?
  if (isPlus) {
    // Plus kullanıcılar yalnızca aylık kota ile sınırlı
    if (usedThisMonth + textLen > remoteConfig.monthly_plus_chars) {
      return false;
    }
  } else {
    // Misafir veya normal kullanıcı: haftalık ve aylık kontrol
    if (usedThisWeek  + textLen > remoteConfig.weekly_free_chars)  return false;
    if (usedThisMonth + textLen > remoteConfig.monthly_free_chars) return false;
  }

  // Güncellenmiş değerleri hesaba katıp Firestore’a yaz
  await docRef.set({
    week:      weekKey,
    weekUsed:  usedThisWeek  + textLen,
    month:     monthKey,
    monthUsed: usedThisMonth + textLen,
  }, { merge: true });

  return true;
}

// — 5) Express uygulaması
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const googleLangMap = {
  'ar-AR': 'ar-XA', 'fa-IR': 'fa-IR', 'tr-TR': 'tr-TR',
  'en-US': 'en-US', 'de-DE': 'de-DE', 'fr-FR': 'fr-FR',
  'es-ES': 'es-ES', 'it-IT': 'it-IT', 'pt-BR': 'pt-BR',
  'pt-PT': 'pt-PT',
};

// — 6) /synthesize endpoint
app.post('/synthesize', async (req, res) => {
  let {
    text,
    gender       = 'FEMALE',
    languageCode = 'tr-TR',
    rate         = 1.0,
    textLen,
    deviceId,
    isPlus       = false,
    saveMp3      = false,
  } = req.body;

  // Gerekli parametre kontrolü
  if (!text || !text.trim())            return res.status(400).json({ error: 'Text is required.' });
  if (!deviceId)                        return res.status(400).json({ error: 'deviceId missing.' });
  if (!textLen)                         textLen = Buffer.byteLength(text, 'utf8');

  // Kota kontrol
  const ok = await checkAndUpdateQuota(deviceId, textLen, isPlus);
  if (!ok) return res.status(429).json({ error: 'quotaExceeded' });

  // Google TTS isteği oluştur
  const voiceLang = googleLangMap[languageCode] || languageCode;
  const voiceName = `${voiceLang}-Wavenet-${gender==='MALE'?'B':'D'}`;
  const request   = {
    input:       { text },
    voice:       { languageCode: voiceLang, ssmlGender: gender, name: voiceName },
    audioConfig: { audioEncoding: 'MP3', speakingRate: parseFloat(rate) },
  };

  try {
    const ttsClient = new textToSpeech.TextToSpeechClient();
    const [response] = await ttsClient.synthesizeSpeech(request);
    const tmpFile = path.join(__dirname, `tmp_${Date.now()}.mp3`);
    await util.promisify(fs.writeFile)(tmpFile, response.audioContent, 'binary');

    // Oluşan MP3’ü gönder
    res.sendFile(tmpFile, {}, (err) => {
      if (!err) setTimeout(() => fs.existsSync(tmpFile) && fs.unlinkSync(tmpFile), 5000);
    });
  } catch (e) {
    console.error('TTS Error:', e);
    res.status(500).json({ error: e.message || 'Google TTS failed.' });
  }
});

// — 7) Kota bilgisi endpoint’i (isteğe bağlı UI için)
app.get('/voice-info', (req, res) => {
  const gender = req.query.gender || 'FEMALE';
  const lang   = req.query.lang    || 'tr-TR';
  res.json({
    selectedVoice: `${googleLangMap[lang]||lang}-Wavenet-${gender==='MALE'?'B':'D'}`,
    weeklyFree:    remoteConfig.weekly_free_chars,
    monthlyFree:   remoteConfig.monthly_free_chars,
    monthlyPlus:   remoteConfig.monthly_plus_chars
  });
});

// — 8) Sunucuyu başlat
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Google TTS server çalışıyor: http://0.0.0.0:${PORT}`);
});

// server.js

const express = require('express');
const fs = require('fs');
const path = require('path');
const textToSpeech = require('@google-cloud/text-to-speech');
const util = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// 🔐 Google kimlik bilgilerini ortam değişkeninden al
//    Örnek: export TTS_SA_JSON="$(cat tts-service-account.json)"
const credentials = JSON.parse(process.env.TTS_SA_JSON);

// 🎤 Google TTS istemcisi
const client = new textToSpeech.TextToSpeechClient({
  credentials: {
    client_email: credentials.client_email,
    private_key: credentials.private_key,
  },
  projectId: credentials.project_id,
});

// Dillerin Google’ın beklediği BCP-47 kodlarına haritası
const googleLangMap = {
  'ar-AR': 'ar-XA',   // Arapça
  'fa-IR': 'fa-IR',   // Farsça
  'tr-TR': 'tr-TR',   // Türkçe
  'en-US': 'en-US',   // İngilizce
  'de-DE': 'de-DE',   // Almanca
  'fr-FR': 'fr-FR',   // Fransızca
  'es-ES': 'es-ES',   // İspanyolca
  'it-IT': 'it-IT',   // İtalyanca
  'pt-BR': 'pt-BR',   // Portekizce (Brezilya)
  'pt-PT': 'pt-PT',   // Portekizce (Portekiz)
};

// Bazı dillerde yalnızca STANDARD ses var
const fallbackVoices = {
  'es-ES': { FEMALE: 'es-ES-Standard-A', MALE: 'es-ES-Standard-B' },
};

// 📢 TTS endpoint – WAVENET veya STANDARD seçimi
app.post('/synthesize', async (req, res) => {
  let {
    text,
    gender = 'FEMALE',
    languageCode = 'tr-TR',
    rate = 1.0,
    voiceType = 'WAVENET',
  } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).send({ error: 'Text is required.' });
  }

  // 1) Dil kodunu haritadan al
  const voiceLang = googleLangMap[languageCode] || languageCode;

  // 2) Hangi sesi kullanacağımızı belirle
  let voiceName;
  if (voiceType === 'WAVENET') {
    voiceName = `${voiceLang}-Wavenet-${gender === 'MALE' ? 'B' : 'D'}`;
  } else {
    voiceName = `${voiceLang}-Standard-${gender === 'MALE' ? 'B' : 'A'}`;
  }

  // 3) Eğer sadece STANDARD sesi varsa fallback yap
  if (fallbackVoices[voiceLang]) {
    voiceName = fallbackVoices[voiceLang][gender];
  }

  const request = {
    input: { text },
    voice: {
      languageCode: voiceLang,
      ssmlGender: gender,
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: parseFloat(rate),
    },
  };

  try {
    const [response] = await client.synthesizeSpeech(request);
    const fileName = `output_${Date.now()}.mp3`;
    const outputPath = path.join(__dirname, fileName);

    // Geçici dosya olarak kaydet
    await util.promisify(fs.writeFile)(
      outputPath,
      response.audioContent,
      'binary'
    );

    // Dosyayı gönder ve 5 saniye sonra sil
    res.sendFile(outputPath, {}, (err) => {
      if (!err) {
        setTimeout(() => {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }, 5000);
      }
    });
  } catch (error) {
    console.error('TTS Error:', error);
    res.status(500).send({ error: error.message || 'Google TTS failed.' });
  }
});

// 🔍 Test endpoint – seçilen voiceName’i görmek için
app.get('/voice-info', (req, res) => {
  const gender    = req.query.gender    || 'FEMALE';
  const lang      = req.query.lang      || 'tr-TR';
  const voiceType = req.query.voiceType || 'WAVENET';

  // 1) Dil kodunu haritadan al
  const voiceLang = googleLangMap[lang] || lang;

  // 2) Wavenet veya Standard seçimi
  let voiceName;
  if (voiceType === 'WAVENET') {
    voiceName = `${voiceLang}-Wavenet-${gender === 'MALE' ? 'B' : 'D'}`;
  } else {
    voiceName = `${voiceLang}-Standard-${gender === 'MALE' ? 'B' : 'A'}`;
  }

  // 3) Fallback
  if (fallbackVoices[voiceLang]) {
    voiceName = fallbackVoices[voiceLang][gender];
  }

  res.json({ selectedVoice: voiceName });
});

// Sunucu başlatma
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Google TTS Sunucusu çalışıyor: http://0.0.0.0:${PORT}`);
});

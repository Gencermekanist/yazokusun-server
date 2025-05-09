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

// 🔐 Google kimlik bilgilerini ortamdan al
const raw = fs.readFileSync(path.join(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS));
const credentials = JSON.parse(raw);

// 🎤 Google TTS istemcisi
const client = new textToSpeech.TextToSpeechClient({
  credentials: {
    client_email: credentials.client_email,
    private_key: credentials.private_key,
  },
  projectId: credentials.project_id,
});

// 📢 TTS endpoint – Çoklu dil ve ses desteği
app.post('/synthesize', async (req, res) => {
  const { text, gender = 'FEMALE', languageCode = 'tr-TR', rate = 1.0 } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).send({ error: 'Text is required.' });
  }

  // 👇 Dili kontrol et – bazı dillerde Wavenet sesi yok
  let voiceName = `${languageCode}-Wavenet-${gender === 'MALE' ? 'B' : 'A'}`;

  // Belirli diller için alternatif sesler
  const fallbackVoices = {
    "es-ES": {
      FEMALE: "es-ES-Standard-A",
      MALE: "es-ES-Standard-B"
    },
  };

  if (fallbackVoices[languageCode]) {
    voiceName = fallbackVoices[languageCode][gender];
  }

  const request = {
    input: { text },
    voice: {
      languageCode,
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
    await util.promisify(fs.writeFile)(outputPath, response.audioContent, 'binary');

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

// 🔍 Test endpoint (opsiyonel)
app.get('/voice-info', (req, res) => {
  const gender = req.query.gender || 'FEMALE';
  const lang = req.query.lang || 'tr-TR';
  let voiceName = `${lang}-Wavenet-${gender === 'MALE' ? 'B' : 'A'}`;

  const fallbackVoices = {
    "es-ES": {
      FEMALE: "es-ES-Standard-A",
      MALE: "es-ES-Standard-B"
    },
  };

  if (fallbackVoices[lang]) {
    voiceName = fallbackVoices[lang][gender];
  }

  res.json({ selectedVoice: voiceName });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Google TTS Sunucusu çalışıyor: http://0.0.0.0:${PORT}`);
});

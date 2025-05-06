const express = require('express');
const fs = require('fs');
const path = require('path');
const textToSpeech = require('@google-cloud/text-to-speech');
const util = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');

// ✅ Render ortamı için Google kimlik dosyasının yolunu belirtiyoruz:
process.env.GOOGLE_APPLICATION_CREDENTIALS = "/etc/secrets/tts-service-account.json";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// ✅ Google TTS istemcisi - kimlik bilgilerini otomatik okur
const client = new textToSpeech.TextToSpeechClient();

// ✅ Metni sese çevirme endpointi
app.post('/synthesize', async (req, res) => {
  const { text, gender = 'FEMALE', languageCode = 'tr-TR' } = req.body;

  if (!text || text.length === 0) {
    return res.status(400).send({ error: 'Text is required.' });
  }

  const voiceName = gender === 'MALE' ? 'tr-TR-Wavenet-B' : 'tr-TR-Wavenet-A';

  const request = {
    input: { text },
    voice: {
      languageCode,
      ssmlGender: gender,
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: 'LINEAR16', // ✅ MP3 yerine WAV formatı
      speakingRate: parseFloat(req.body.rate || 1.0),
    },
  };

  try {
    const [response] = await client.synthesizeSpeech(request);

    const fileName = `output_${Date.now()}.wav`; // ✅ uzantı .wav oldu
    const outputPath = path.join(__dirname, fileName);
    await util.promisify(fs.writeFile)(outputPath, response.audioContent, 'binary');

    res.sendFile(outputPath, {}, (err) => {
      if (!err) {
        setTimeout(() => fs.unlinkSync(outputPath), 5000); // 5 saniye sonra sil
      }
    });
  } catch (error) {
    console.error('TTS Error:', error);
    res.status(500).send({ error: error.message || 'Google TTS failed.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Google TTS Sunucusu çalışıyor: http://0.0.0.0:${PORT}`);
});

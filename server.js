
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

// GOOGLE_APPLICATION_CREDENTIALS dosyasını tanımla
const CREDENTIALS = require('./tts-service-account.json');

// Google Cloud TTS istemcisi
const client = new textToSpeech.TextToSpeechClient({
  credentials: CREDENTIALS,
});

// Ana API: Flutter'dan metin ve ses tercihini alır
app.post('/synthesize', async (req, res) => {
  const { text, gender = 'FEMALE', languageCode = 'tr-TR' } = req.body;

  if (!text || text.length === 0) {
    return res.status(400).send({ error: 'Text is required.' });
  }

  const request = {
    input: { text },
    voice: {
      languageCode,
      ssmlGender: gender,
    },
    audioConfig: {
      audioEncoding: 'MP3',
    },
  };

  try {
    const [response] = await client.synthesizeSpeech(request);

    const fileName = `output_${Date.now()}.mp3`;
    const outputPath = path.join(__dirname, fileName);
    await util.promisify(fs.writeFile)(outputPath, response.audioContent, 'binary');

    res.sendFile(outputPath, {}, (err) => {
      if (!err) {
        // 5 saniye sonra sil
        setTimeout(() => fs.unlinkSync(outputPath), 5000);
      }
    });
  } catch (error) {
    console.error('TTS Error:', error);
    res.status(500).send({ error: 'Google TTS failed.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Google TTS Sunucusu çalışıyor: http://localhost:${PORT}`);
});

const express = require('express');
const fs = require('fs');
const path = require('path');
const textToSpeech = require('@google-cloud/text-to-speech');
const util = require('util');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const CREDENTIALS = require('./tts-service-account.json');
const client = new textToSpeech.TextToSpeechClient({ credentials: CREDENTIALS });

app.post('/synthesize', async (req, res) => {
  try {
    const { text, gender = 'FEMALE', languageCode = 'tr-TR' } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).send('Metin eksik.');
    }

    const request = {
      input: { text },
      voice: { languageCode, ssmlGender: gender },
      audioConfig: { audioEncoding: 'LINEAR16' } // WAV formatı
    };

    const [response] = await client.synthesizeSpeech(request);
    const buffer = response.audioContent;

    res.set({
      'Content-Type': 'audio/wav',
      'Content-Disposition': 'attachment; filename="tts.wav"',
    });

    res.send(buffer);
  } catch (err) {
    console.error('Hata:', err);
    res.status(500).send('Ses üretiminde hata oluştu.');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Google TTS Sunucusu çalışıyor: http://localhost:${PORT}`);
});

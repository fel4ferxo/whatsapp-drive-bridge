const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuración de Google Drive
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'credentials.json'),
  scopes: SCOPES,
});
const drive = google.drive({ version: 'v3', auth });

// Configuración de whatsapp-web.js
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'],
  },
});

// Mostrar QR en los logs de Render
client.on('qr', (qr) => {
  console.log('Escanea este QR con tu WhatsApp:');
  qrcode.generate(qr, { small: true });
});

// Confirmar conexión
client.on('ready', () => {
  console.log('WhatsApp conectado');
});

// Procesar mensajes entrantes
client.on('message', async (msg) => {
  try {
    if (msg.hasMedia && (msg.type === 'document' || msg.type === 'image')) {
      const media = await msg.downloadMedia();
      const fileExtension = msg.type === 'document' ? 'pdf' : 'jpg';
      const fileName = `file_${Date.now()}.${fileExtension}`;
      const tempFilePath = path.join(__dirname, fileName);

      // Guardar archivo temporalmente
      fs.writeFileSync(tempFilePath, Buffer.from(media.data, 'base64'));

      // Subir a Google Drive
      const fileMetadata = {
        name: fileName,
        parents: ['1QQ25ZXiOPn2TjImHL0gEvEu-nenlR6xS'], // Reemplaza con el ID de tu carpeta
      };
      const mediaUpload = {
        mimeType: msg.type === 'document' ? 'application/pdf' : 'image/jpeg',
        body: fs.createReadStream(tempFilePath),
      };

      const uploadedFile = await drive.files.create({
        resource: fileMetadata,
        media: mediaUpload,
        fields: 'id',
      });

      console.log(`Archivo subido a Drive: ${fileName}, ID: ${uploadedFile.data.id}`);

      // Eliminar archivo temporal
      fs.unlinkSync(tempFilePath);

      // Responder al usuario (evita parecer automatizado)
      await msg.reply('Archivo recibido y subido a Drive. ¡Gracias!');
    } else {
      // Responder a mensajes no multimedia para simular interacción humana
      if (!msg.isStatus && !msg.fromMe) {
        await msg.reply('Por favor, envía un PDF o imagen para procesar.');
      }
    }
  } catch (error) {
    console.error('Error procesando mensaje:', error);
  }
});

// Evitar suspensión: Limitar tasa de mensajes salientes
const RATE_LIMIT = {
  maxMessages: 10, // Máximo 10 mensajes por hora
  windowMs: 60 * 60 * 1000, // 1 hora
  messages: new Map(),
};

async function checkRateLimit(chatId) {
  const now = Date.now();
  const messages = RATE_LIMIT.messages.get(chatId) || [];
  const recentMessages = messages.filter((time) => now - time < RATE_LIMIT.windowMs);
  recentMessages.push(now);
  RATE_LIMIT.messages.set(chatId, recentMessages);
  return recentMessages.length <= RATE_LIMIT.maxMessages;
}

// Modificar envío de mensajes para incluir límite de tasa
const originalSendMessage = client.sendMessage;
client.sendMessage = async (chatId, content, options) => {
  if (await checkRateLimit(chatId)) {
    return originalSendMessage.call(client, chatId, content, options);
  } else {
    console.log(`Límite de mensajes alcanzado para ${chatId}`);
    return null;
  }
};

// Iniciar cliente de WhatsApp
client.initialize();

// Webhook para verificar el servidor
app.get('/webhook', (req, res) => {
  res.status(200).send('Servidor activo');
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
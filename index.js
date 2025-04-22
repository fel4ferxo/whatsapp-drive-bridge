const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuración de Google Drive (temporalmente comentada)
/*
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'credentials.json'),
  scopes: SCOPES,
});
const drive = google.drive({ version: 'v3', auth });
*/

// Configuración de whatsapp-web.js
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'],
  },
});

// Número principal y receptor (con código de país +51)
const MAIN_NUMBER = '51923838671@c.us'; // Número principal que recibe los mensajes
const RECEIVER_NUMBER = '51906040838@c.us'; // Número receptor al que se reenviarán los archivos

// Mostrar QR en los logs de Render
client.on('qr', (qr) => {
  console.log('Escanea este QR con tu WhatsApp:');
  qrcode.generate(qr, { small: true });
});

// Confirmar conexión y listar contactos para depuración
client.on('ready', () => {
  console.log('WhatsApp conectado');
  // Verificar si el número receptor es accesible
  client.getChats().then(chats => {
    const receiverChat = chats.find(chat => chat.id._serialized === RECEIVER_NUMBER);
    if (receiverChat) {
      console.log(`Chat con ${RECEIVER_NUMBER} encontrado:`, receiverChat.id._serialized);
    } else {
      console.log(`No se encontró un chat con ${RECEIVER_NUMBER}. Asegúrate de que el número sea correcto y esté registrado en WhatsApp.`);
      console.log('Intenta enviar un mensaje manual desde', MAIN_NUMBER, 'a', RECEIVER_NUMBER, 'para inicializar el chat.');
    }
  }).catch(err => {
    console.error('Error al obtener chats:', err);
  });
});

// Manejar desconexiones
client.on('disconnected', (reason) => {
  console.log('Cliente desconectado:', reason);
  // Intentar reconectar
  client.initialize();
});

// Función para procesar mensajes (real o simulado)
async function processMessage(msg) {
  try {
    // Verifica que el mensaje no sea del número principal ni del receptor (para evitar bucles)
    if (msg.from !== MAIN_NUMBER && msg.from !== RECEIVER_NUMBER) {
      if (msg.hasMedia && (msg.type === 'document' || msg.type === 'image')) {
        const media = await msg.downloadMedia();
        const fileExtension = msg.type === 'document' ? 'pdf' : 'jpg';
        const fileName = `file_${Date.now()}.${fileExtension}`;
        const tempFilePath = path.join(__dirname, fileName);

        // Guardar archivo temporalmente
        fs.writeFileSync(tempFilePath, Buffer.from(media.data, 'base64'));

        // Subida a Google Drive (temporalmente comentada)
        /*
        const fileMetadata = {
          name: fileName,
          parents: ['1QQ25ZXiOPn2TjImHL0gEvEu-nenlR6xS'],
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
        */

        // Validar el chat receptor antes de enviar
        const chat = await client.getChatById(RECEIVER_NUMBER).catch(err => {
          console.error(`Error al obtener el chat con ${RECEIVER_NUMBER}:`, err);
          throw new Error(`No se pudo acceder al chat con ${RECEIVER_NUMBER}`);
        });

        // Reenviar el archivo al número receptor como si lo enviara el número principal
        await msg.forward(RECEIVER_NUMBER).catch(err => {
          console.error(`Error al reenviar mensaje a ${RECEIVER_NUMBER}:`, err);
          throw err;
        });
        console.log(`Archivo reenviado a ${RECEIVER_NUMBER} como si lo enviara ${MAIN_NUMBER}`);

        // Responder al usuario
        await msg.reply('Archivo recibido. ¡Gracias!');

        // Eliminar archivo temporal
        fs.unlinkSync(tempFilePath);
      } else {
        // Responder a mensajes no multimedia
        if (!msg.isStatus && !msg.fromMe) {
          await msg.reply('Por favor, envía un PDF o imagen para procesar.');
        }
      }
    } else {
      console.log(`Mensaje ignorado: proviene de ${msg.from}, pero solo se procesan mensajes de otros números`);
    }
  } catch (error) {
    console.error('Error procesando mensaje:', error);
  }
}

// Procesar mensajes entrantes reales
client.on('message', async (msg) => {
  await processMessage(msg);
});

// Endpoint para simular un mensaje
app.post('/simulate', async (req, res) => {
  try {
    const fileType = req.body.fileType || 'document'; // 'document' para PDF, 'image' para JPG
    const filePath = fileType === 'document' ? 'test.pdf' : 'test.jpg';

    // Verifica que el archivo exista
    if (!fs.existsSync(filePath)) {
      return res.status(400).send('Archivo de prueba no encontrado. Asegúrate de tener test.pdf o test.jpg en la raíz del proyecto.');
    }

    // Lee el archivo y crea un objeto MessageMedia
    const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
    const media = new MessageMedia(
      fileType === 'document' ? 'application/pdf' : 'image/jpeg',
      fileData,
      `test.${fileType === 'document' ? 'pdf' : 'jpg'}`
    );

    // Crea un mensaje simulado (simulamos que viene del número de prueba +51 123 456 789)
    const simulatedMessage = {
      from: '51900813250@c.us', // Número de prueba como remitente
      hasMedia: true,
      type: fileType,
      downloadMedia: async () => media,
      reply: async (content) => {
        console.log(`Respuesta simulada a ${simulatedMessage.from}: ${content}`);
        return true;
      },
      forward: async (chatId) => {
        console.log(`Simulación: Reenviando mensaje a ${chatId}`);
        return true;
      },
    };

    // Procesa el mensaje simulado
    await processMessage(simulatedMessage);

    res.status(200).send('Mensaje simulado enviado correctamente.');
  } catch (error) {
    console.error('Error al simular mensaje:', error);
    res.status(500).send('Error al simular mensaje.');
  }
});

// Evitar suspensión: Limitar tasa de mensajes salientes
const RATE_LIMIT = {
  maxMessages: 10,
  windowMs: 60 * 60 * 1000,
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
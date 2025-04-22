const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Configuración de whatsapp-web.js
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'],
  },
});

// Número principal y receptor
const MAIN_NUMBER = '+51923838671@c.us';
const RECEIVER_NUMBER = '+51906040838@c.us';

// Mostrar QR en los logs de Render
client.on('qr', (qr) => {
  console.log('Escanea este QR con tu WhatsApp:');
  qrcode.generate(qr, { small: true });
});

// Confirmar conexión
client.on('ready', () => {
  console.log('WhatsApp conectado');
  // Inicializar el chat con el receptor
  client.sendMessage(RECEIVER_NUMBER, 'Inicializando chat desde el bot').then(() => {
    console.log(`Chat inicializado con ${RECEIVER_NUMBER}`);
  }).catch(err => {
    console.error(`Error al inicializar chat con ${RECEIVER_NUMBER}:`, err);
  });
});

// Manejar desconexiones
client.on('disconnected', (reason) => {
  console.log('Cliente desconectado:', reason);
  client.initialize();
});

// Procesar mensajes
async function processMessage(msg) {
  try {
    if (msg.from !== MAIN_NUMBER && msg.from !== RECEIVER_NUMBER) {
      if (msg.hasMedia && (msg.type === 'document' || msg.type === 'image')) {
        console.log(`Procesando mensaje de ${msg.from}, tipo: ${msg.type}`);

        const media = await msg.downloadMedia();
        const fileExtension = msg.type === 'document' ? 'pdf' : 'jpg';
        const fileName = `file_${Date.now()}.${fileExtension}`;
        const tempFilePath = path.join(__dirname, fileName);

        fs.writeFileSync(tempFilePath, Buffer.from(media.data, 'base64'));

        console.log(`Intentando enviar archivo a ${RECEIVER_NUMBER}`);
        const mediaToSend = new MessageMedia(
          msg.type === 'document' ? 'application/pdf' : 'image/jpeg',
          media.data,
          fileName
        );
        await client.sendMessage(RECEIVER_NUMBER, mediaToSend).catch(err => {
          console.error(`Error al enviar archivo a ${RECEIVER_NUMBER}:`, err);
          throw err;
        });
        console.log(`Archivo enviado a ${RECEIVER_NUMBER} desde ${MAIN_NUMBER}`);

        console.log(`Intentando responder a ${msg.from}`);
        await msg.reply('Archivo recibido. ¡Gracias!').catch(err => {
          console.error(`Error al responder a ${msg.from}:`, err);
          throw err;
        });

        fs.unlinkSync(tempFilePath);
      } else {
        if (!msg.isStatus && !msg.fromMe) {
          await msg.reply('Por favor, envía un PDF o imagen para procesar.');
        }
      }
    } else {
      console.log(`Mensaje ignorado: proviene de ${msg.from}`);
    }
  } catch (error) {
    console.error('Error procesando mensaje:', error);
  }
}

// Procesar mensajes entrantes reales
client.on('message', async (msg) => {
  console.log('Mensaje real recibido:', msg.from, msg.type);
  await processMessage(msg);
});

// Endpoint para simular un mensaje
app.post('/simulate', async (req, res) => {
  try {
    const fileType = req.body.fileType || 'document';
    const filePath = fileType === 'document' ? 'test.pdf' : 'test.jpg';

    if (!fs.existsSync(filePath)) {
      return res.status(400).send('Archivo de prueba no encontrado. Asegúrate de tener test.pdf o test.jpg en la raíz del proyecto.');
    }

    const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
    const media = new MessageMedia(
      fileType === 'document' ? 'application/pdf' : 'image/jpeg',
      fileData,
      `test.${fileType === 'document' ? 'pdf' : 'jpg'}`
    );

    const simulatedMessage = {
      from: '+51123456789@c.us',
      hasMedia: true,
      type: fileType,
      downloadMedia: async () => media,
      reply: async (content) => {
        console.log(`Respuesta simulada a ${simulatedMessage.from}: ${content}`);
        return true;
      },
    };

    console.log('Procesando mensaje simulado');
    await processMessage(simulatedMessage);

    res.status(200).send('Mensaje simulado procesado correctamente. Nota: Esto es una simulación, el mensaje no se envía realmente a WhatsApp.');
  } catch (error) {
    console.error('Error al simular mensaje:', error);
    res.status(500).send('Error al simular mensaje.');
  }
});

// Webhook para verificar el servidor
app.get('/webhook', (req, res) => {
  res.status(200).send('Servidor activo');
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Iniciar cliente de WhatsApp
client.initialize();
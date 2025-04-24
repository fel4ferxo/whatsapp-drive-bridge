const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

// Números principal y secundario
const MAIN_NUMBER = '923838671'; // Sin el prefijo +
const SECONDARY_NUMBER = '51906040838'; // Número secundario fijo, con prefijo +51

async function connectToWhatsApp() {
  // Configurar la autenticación (almacenar en /tmp para evitar problemas de permisos en Render)
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/whatsapp-auth');

  // Crear el cliente de WhatsApp
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Vamos a manejar el QR manualmente
  });

  // Mostrar el QR para autenticación
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escanea este QR con WhatsApp (número principal: 923838671):');
      qrcode.generate(qr, { small: true }, (code) => {
        console.log('QR generado en los logs. Escanea con el número principal.');
        console.log(code);
      });
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado. Número principal: 923838671');
      // Enviar mensaje de prueba al secundario
      try {
        await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: 'Bot conectado exitosamente.' });
        console.log(`Mensaje de prueba enviado a ${SECONDARY_NUMBER}`);
      } catch (error) {
        console.error(`Error al enviar mensaje de prueba a ${SECONDARY_NUMBER}:`, error);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada:', lastDisconnect?.error, 'Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    }
  });

  // Guardar las credenciales cuando se actualicen
  sock.ev.on('creds.update', saveCreds);

  // Reenviar mensajes recibidos por el número principal al secundario
  sock.ev.on('messages.upsert', async (m) => {
    const messages = m.messages;
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
        const senderNumber = msg.key.remoteJid.split('@')[0];
        if (senderNumber === MAIN_NUMBER) {
          console.log(`Mensaje ignorado: proviene de ${senderNumber}`);
          continue;
        }

        // Incluir el número de origen en el mensaje reenviado
        const originMessage = `\n\nRecibido por: ${senderNumber}`;

        // Manejar diferentes tipos de mensajes
        let messageContent = '';

        // Mensajes de texto
        if (msg.message?.conversation) {
          messageContent = msg.message.conversation;
          console.log(`Mensaje de texto recibido de ${senderNumber}: ${messageContent}`);
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: messageContent + originMessage });
          console.log(`Mensaje de texto reenviado a ${SECONDARY_NUMBER}: ${messageContent}`);
        }
        // Mensajes extendidos (texto con contexto, como respuestas)
        else if (msg.message?.extendedTextMessage?.text) {
          messageContent = msg.message.extendedTextMessage.text;
          console.log(`Mensaje de texto extendido recibido de ${senderNumber}: ${messageContent}`);
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: messageContent + originMessage });
          console.log(`Mensaje de texto extendido reenviado a ${SECONDARY_NUMBER}: ${messageContent}`);
        }
        // Imágenes
        else if (msg.message?.imageMessage) {
          console.log(`Imagen recibida de ${senderNumber}`);
          const caption = (msg.message.imageMessage.caption || '') + originMessage;
          const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, {
            image: buffer,
            caption: caption,
          });
          console.log(`Imagen reenviada a ${SECONDARY_NUMBER} con caption: ${caption}`);
        }
        // Documentos (PDFs, etc.)
        else if (msg.message?.documentMessage) {
          console.log(`Documento recibido de ${senderNumber}`);
          const fileName = msg.message.documentMessage.fileName || 'documento';
          const stream = await downloadContentFromMessage(msg.message.documentMessage, 'document');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, {
            document: buffer,
            mimetype: msg.message.documentMessage.mimetype,
            fileName: fileName,
            caption: originMessage,
          });
          console.log(`Documento reenviado a ${SECONDARY_NUMBER}: ${fileName}`);
        }
        // Videos
        else if (msg.message?.videoMessage) {
          console.log(`Video recibido de ${senderNumber}`);
          const caption = (msg.message.videoMessage.caption || '') + originMessage;
          const stream = await downloadContentFromMessage(msg.message.videoMessage, 'video');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, {
            video: buffer,
            caption: caption,
          });
          console.log(`Video reenviado a ${SECONDARY_NUMBER} con caption: ${caption}`);
        }
        // Otros tipos de mensajes (audio, stickers, etc.)
        else {
          console.log(`Mensaje de tipo no manejado recibido de ${senderNumber}:`, msg.message);
        }
      }
    }
  });
}

// Iniciar la conexión
connectToWhatsApp();
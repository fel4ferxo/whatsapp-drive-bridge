const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal'); // Para mostrar el QR en los logs

// Números principal y secundario
const MAIN_NUMBER = '923838671'; // Sin el prefijo +
const SECONDARY_NUMBER = '51906040838'; // Sin el prefijo +

async function connectToWhatsApp() {
  // Configurar la autenticación (almacenar en memoria o en /tmp para evitar problemas de permisos)
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

        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        console.log(`Mensaje recibido de ${senderNumber}: ${messageContent}`);

        // Reenviar el mensaje al número secundario
        try {
          await sock.sendMessage(`${SECONDARY_NUMBER}@s.whatsapp.net`, { text: messageContent });
          console.log(`Mensaje reenviado a ${SECONDARY_NUMBER}: ${messageContent}`);
        } catch (error) {
          console.error(`Error al reenviar mensaje a ${SECONDARY_NUMBER}:`, error);
        }
      }
    }
  });
}

// Iniciar la conexión
connectToWhatsApp();
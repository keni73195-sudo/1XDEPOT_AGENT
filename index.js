const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// 🌟 URL FIREBASE DEPUIS GITHUB SECRETS 🌟
const FIREBASE_URL = process.env.FIREBASE_URL;

// 📦 État des commandes par client
const orderStates = {};

// ============================================================
// 🔥 RÉCUPÉRER LES MONTANTS DEPUIS FIREBASE
// ============================================================
async function getAmountsFromApp() {
    try {
        const response = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await response.json();
        if (!data) return [];
        
        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            price: data[key].price,
            imageUrl: data[key].imageUrl
        }));
    } catch (error) {
        console.error("Erreur récupération menu:", error);
        return [];
    }
}

// ============================================================
// 💳 MOYENS DE PAIEMENT
// ============================================================
const PAYMENT_METHODS = [
    { id: 1, name: "Wave",             number: "+229 XX XX XX XX" },
    { id: 2, name: "Orange Money",     number: "+229 XX XX XX XX" },
    { id: 3, name: "MTN Mobile Money", number: "+229 XX XX XX XX" },
    { id: 4, name: "Moov Money",       number: "+229 XX XX XX XX" }
];

// ============================================================
// 🚀 DÉMARRAGE DU BOT
// ============================================================
async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERREUR : FIREBASE_URL manquant dans les secrets GitHub !");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["1XDEPOT", "Chrome", "1.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.clear();
            console.log('\n==================================================');
            console.log('⚠️ QR CODE TROP GRAND ? Cliquez "View raw logs"');
            console.log('==================================================\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') console.log('✅ 1XDEPOT EST EN LIGNE !');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ============================================================
    // 📩 GESTION DES MESSAGES
    // ============================================================
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim().toLowerCase();

        console.log(`📩 Message de ${sender}: ${text}`);

        const state = orderStates[sender];

        // ============================================================
        // 🔄 ÉTAPE 3 : LE CLIENT ENVOIE SON ID 1XBET
        // ============================================================
        if (state?.step === 'WAITING_FOR_ID') {
            if (!/^\d{5,15}$/.test(text)) {
                await sock.sendMessage(sender, {
                    text: "❌ ID invalide.\n\nEnvoyez uniquement des chiffres (ex: *123456789*)"
                });
                return;
            }

            state.userId1xbet = text;
            state.step = 'CHOOSING_PAYMENT';

            let paymentMsg = "✔️ ID enregistré : *" + text + "*\n\n";
            paymentMsg += "━━━━━━━━━━━━━━━\n\n";
            paymentMsg += "💳 *CHOISISSEZ VOTRE MOYEN DE PAIEMENT*\n\n";
            PAYMENT_METHODS.forEach(p => {
                paymentMsg += `${p.id}️⃣ ${p.name}\n`;
            });
            paymentMsg += "\n👉 Répondez avec un chiffre (1-4)";

            await sock.sendMessage(sender, { text: paymentMsg });
            return;
        }

        // ============================================================
        // 🔄 ÉTAPE 4 : LE CLIENT CHOISIT LE PAIEMENT
        // ============================================================
        if (state?.step === 'CHOOSING_PAYMENT') {
            const choice = parseInt(text);
            const method = PAYMENT_METHODS.find(p => p.id === choice);

            if (!method) {
                await sock.sendMessage(sender, {
                    text: "❌ Choix invalide.\n\nRépondez avec un chiffre entre *1* et *4*"
                });
                return;
            }

            state.paymentMethod = method.name;
            state.step = 'WAITING_FOR_PAYMENT';

            const payMsg =
                `📲 *Paiement ${method.name}*\n\n` +
                `Envoyez *${state.amount.name}* au :\n\n` +
                `📞 ${method.number}\n` +
                `👤 1XDEPOT\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `Une fois payé, tapez :\n\n` +
                `1️⃣ J'ai payé ✅\n` +
                `2️⃣ Annuler ❌`;

            await sock.sendMessage(sender, { text: payMsg });
            return;
        }

        // ============================================================
        // 🔄 ÉTAPE 5 : LE CLIENT CONFIRME LE PAIEMENT
        // ============================================================
        if (state?.step === 'WAITING_FOR_PAYMENT') {
            if (text === '1') {
                const customerWaNumber = sender.split('@')[0];

                const oneXOrder = {
                    userId: "whatsapp_" + customerWaNumber,
                    userEmail: "whatsapp@1xdepot.com",
                    phone: customerWaNumber,
                    address: "ID 1xBet: " + state.userId1xbet + " | Paiement: " + state.paymentMethod,
                    location: { lat: 0, lng: 0 },
                    items: [{
                        id: state.amount.id,
                        name: state.amount.name,
                        price: parseFloat(state.amount.price),
                        img: state.amount.imageUrl || "",
                        quantity: 1
                    }],
                    total: parseFloat(state.amount.price).toFixed(2),
                    status: "Placed",
                    method: "Recharge 1xBet (WhatsApp)",
                    timestamp: new Date().toISOString()
                };

                try {
                    await fetch(`${FIREBASE_URL}/orders.json`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(oneXOrder)
                    });
                } catch (error) {
                    console.log("Erreur Firebase:", error);
                }

                await sock.sendMessage(sender, {
                    text:
                        `⏳ *Vérification en cours...*\n\n` +
                        `Votre demande a été transmise à notre équipe.\n` +
                        `Vous recevrez une confirmation dans 2 minutes.\n\n` +
                        `Merci de votre confiance 🙏`
                });

                delete orderStates[sender];
                return;
            } 
            
            if (text === '2') {
                delete orderStates[sender];
                await sock.sendMessage(sender, {
                    text: "❌ Commande annulée.\n\nTapez *menu* pour recommencer."
                });
                return;
            }

            await sock.sendMessage(sender, {
                text: "❌ Choix invalide.\n\nRépondez *1* pour confirmer ou *2* pour annuler."
            });
            return;
        }

        // ============================================================
        // 🔄 ÉTAPE 2 : LE CLIENT CHOISIT LE MONTANT
        // ============================================================
        if (state?.step === 'CHOOSING_AMOUNT') {
            const choice = parseInt(text);
            const amounts = await getAmountsFromApp();
            const selected = amounts[choice - 1];

            if (!selected) {
                await sock.sendMessage(sender, {
                    text: `❌ Choix invalide.\n\nRépondez avec un chiffre entre *1* et *${amounts.length}*`
                });
                return;
            }

            state.amount = selected;
            state.step = 'WAITING_FOR_ID';

            await sock.sendMessage(sender, {
                text:
                    `✅ Vous avez choisi : *${selected.name}*\n\n` +
                    `━━━━━━━━━━━━━━━\n\n` +
                    `📝 Entrez votre *ID 1xBet*\n` +
                    `(ex: 123456789)`
            });
            return;
        }

        // ============================================================
        // 🚫 ANNULATION À TOUT MOMENT
        // ============================================================
        if (text === 'annuler' || text === 'stop' || text === 'cancel') {
            if (orderStates[sender]) {
                delete orderStates[sender];
                await sock.sendMessage(sender, {
                    text: "❌ Commande annulée.\n\nTapez *menu* pour recommencer."
                });
                return;
            }
        }

        // ============================================================
        // 🍔 AFFICHER LE MENU
        // ============================================================
        if (
            text.includes("menu") ||
            text.includes("recharge") ||
            text.includes("carte") ||
            text.includes("tarif") ||
            text.includes("prix") ||
            text.includes("depot") ||
            text.includes("dépôt")
        ) {
            const amounts = await getAmountsFromApp();

            if (amounts.length === 0) {
                await sock.sendMessage(sender, {
                    text: "Notre menu est en cours de mise à jour.\n\nRevenez dans quelques instants 🙏"
                });
                return;
            }

            orderStates[sender] = { step: 'CHOOSING_AMOUNT' };

            let menuMsg = "👋 Bienvenue sur *1XDEPOT*\n\n";
            menuMsg += "Choisissez votre montant de recharge :\n\n";

            amounts.forEach((a, i) => {
                menuMsg += `${i + 1}️⃣ ${a.name}\n`;
            });

            menuMsg += `\n👉 Répondez avec un chiffre (1-${amounts.length})`;

            await sock.sendMessage(sender, { text: menuMsg });
            return;
        }

        // ============================================================
        // 👋 SALUTATIONS
        // ============================================================
        if (
            text.includes("bonjour") ||
            text.includes("salut") ||
            text.includes("bonsoir") ||
            text.includes("coucou") ||
            text.includes("hi") ||
            text.includes("hello") ||
            text.includes("hey")
        ) {
            await sock.sendMessage(sender, {
                text:
                    `👋 *Bienvenue sur 1XDEPOT !*\n\n` +
                    `Votre plateforme de recharge 1xBet rapide et sécurisée.\n\n` +
                    `Tapez *menu* pour voir nos tarifs 🚀`
            });
            return;
        }

        // ============================================================
        // 📞 CONTACT / AIDE
        // ============================================================
        if (
            text.includes("contact") ||
            text.includes("aide") ||
            text.includes("infos") ||
            text.includes("support") ||
            text.includes("appeler") ||
            text.includes("call")
        ) {
            await sock.sendMessage(sender, {
                text:
                    `📞 *Support 1XDEPOT*\n\n` +
                    `- WhatsApp : +229 XX XX XX XX\n` +
                    `- Email : support@1xdepot.com\n\n` +
                    `Nous répondons 24h/24 🕐`
            });
            return;
        }

        // ============================================================
        // 🤔 MESSAGE INCOMPRIS
        // ============================================================
        await sock.sendMessage(sender, {
            text:
                `🤔 Je n'ai pas bien compris.\n\n` +
                `Tapez *menu* pour voir nos tarifs,\n` +
                `ou *aide* pour contacter le support.`
        });
    });
}

startBot().catch(err => console.log("Erreur: " + err));

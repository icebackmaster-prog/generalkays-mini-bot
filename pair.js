const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require("form-data");
const os = require('os'); 
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('queenruva-sockets');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💋', '🍬', '🫆', '💗', '🎈', '🎉', '🥳', '❤️', '🧫', '🐭'],
    PREFIX: '.',
    MODE: 'public', // New property: 'self' or 'public'
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/GMF5TeVkmAuGAXRnUEQZcW?s=cl&p=a&ilr=4',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/9gxtcc.jpg',
    NEWSLETTER_JID: '120363419693990894@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    version: '1.0.0',
    OWNER_NUMBER: '+263789642910',
    BOT_FOOTER: 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays ᴛᴇᴄʜ',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb8SoLw11ulLVkjqv140'
};

const octokit = new Octokit({ auth: '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' });
const owner = 'dev-iceback';
const repo = 'session';

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        const configFiles = data.filter(file => 
            file.name === `config_${sanitizedNumber}.json`
        );

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }

        if (configFiles.length > 0) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

// Count total commands in pair.js
let totalcmds = async () => {
    try {
        const filePath = "./pair.js";
        const mytext = await fs.readFile(filePath, "utf-8");

        // Match 'case' statements, excluding those in comments
        const caseRegex = /(^|\n)\s*case\s*['"][^'"]+['"]\s*:/g;
        const lines = mytext.split("\n");
        let count = 0;

        for (const line of lines) {
            // Skip lines that are comments
            if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;
            // Check if line matches case statement
            if (line.match(/^\s*case\s*['"][^'"]+['"]\s*:/)) {
                count++;
            }
        }

        return count;
    } catch (error) {
        console.error("Error reading pair.js:", error.message);
        return 0; // Return 0 on error to avoid breaking the bot
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES || 3;
    let inviteCode = 'F9unOZeoGvF3uqcbT29zLl'; // Hardcoded default
    if (config.GROUP_INVITE_LINK) {
        const cleanInviteLink = config.GROUP_INVITE_LINK.split('?')[0]; // Remove query params
        const inviteCodeMatch = cleanInviteLink.match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]+)/);
        if (!inviteCodeMatch) {
            console.error('Invalid group invite link format:', config.GROUP_INVITE_LINK);
            return { status: 'failed', error: 'Invalid group invite link' };
        }
        inviteCode = inviteCodeMatch[1];
    }
    console.log(`Attempting to join group with invite code: ${inviteCode}`);

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            console.log('Group join response:', JSON.stringify(response, null, 2)); // Debug response
            if (response?.gid) {
                console.log(`[ ✅ ] Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone') || error.message.includes('not-found')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group: ${errorMessage} (Retries left: ${retries})`);
            if (retries === 0) {
                console.error('[ ❌ ] Failed to join group', { error: errorMessage });
                try {
                    await socket.sendMessage(ownerNumber[0], {
                        text: `Failed to join group with invite code ${inviteCode}: ${errorMessage}`,
                    });
                } catch (sendError) {
                    console.error(`Failed to send failure message to owner: ${sendError.message}`);
                }
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries + 1));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `ᴊᴏɪɴᴇᴅ (ID: ${groupResult.gid})`
        : `ɢʀᴜᴘ ᴊᴏɪɴ ғᴀɪʟ: ${groupResult.error}`;
    const caption = formatMessage(
        'ᴄᴏɴɴᴇᴄᴛᴇᴅ sᴜᴄᴄᴇssᴇғᴜʟʟʏ ✅',
        `📞 ɴᴜᴍʙᴇʀ: ${number}\n🩵 sᴛᴀᴛᴜs: Oɴʟɪɴᴇ`,
        `${config.BOT_FOOTER}`
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
            console.log(`Connect message sent to admin ${admin}`);
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error.message);
        }
    }
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        'ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays ᴛᴇᴄʜ'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🔥', '😀', '👍', '🐭'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            'generalkays ᴍɪɴɪ ʙᴏᴛ'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}


async function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.message[type]?.message?.imageMessage?.caption || msg.message[type]?.message?.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        let userConfig = await loadUserConfig(sanitizedNumber); // Load user-specific config
        let prefix = userConfig.PREFIX || config.PREFIX; // Use user-specific prefix
        let mode = userConfig.MODE || config.MODE; // Use user-specific mode
        const isCmd = body.startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        const args = body.trim().split(/ +/).slice(1);

        // Restrict commands in self mode to owner only
        if (mode === 'self' && !isOwner) {
            return; // Silently ignore commands from non-owners in self mode
        }

        async function isGroupAdmin(jid, user) {
            try {
                const groupMetadata = await socket.groupMetadata(jid);
                const participant = groupMetadata.participants.find(p => p.id === user);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin' || false;
            } catch (error) {
                console.error('Error checking group admin status:', error);
                return false;
            }
        }

        const isSenderGroupAdmin = isGroup ? await isGroupAdmin(from, nowsender) : false;

        socket.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        if (!command) return;
        const count = await totalcmds();

        const fakevCard = {
            key: {
                fromMe: false,
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast"
            },
            message: {
                contactMessage: {
                    displayName: "© generalkays ᴛᴇᴄʜ",
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Meta\nORG:META AI;\nTEL;type=CELL;type=VOICE;waid=263787337998:+263787337998\nEND:VCARD`
                }
            }
        };

        try {
            switch (command) {
                case 'alive': {
                    try {
                        await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                        const startTime = socketCreationTime.get(number) || Date.now();
                        const uptime = Math.floor((Date.now() - startTime) / 1000);
                        const hours = Math.floor(uptime / 3600);
                        const minutes = Math.floor((uptime % 3600) / 60);
                        const seconds = Math.floor(uptime % 60);

                        const captionText = `
*┌────────────⏣*                       
*╽⏰ ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s*
*┃🤖 ᴀᴄᴛɪᴠᴇ ʙᴏᴛs: ${activeSockets.size}*
*┃📱 ʏᴏᴜʀ ɴᴜᴍʙᴇʀ: ${number}*
*┃🕹️ ᴠᴇʀsɪᴏɴ: ${config.version}*
*┃💾 ᴍᴇᴍᴏʀʏ ᴜsᴀɢᴇ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB*
*└─────────────⏣

> *🌐 ᴍɪɴɪ ᴡᴇʙsɪᴛᴇ*
- https://generalkays-mini-bot.onrender.com/
> ʀᴇsᴘᴏɴᴅ ᴛɪᴍᴇ: ${Date.now() - msg.messageTimestamp * 1000}ms`;

                        const aliveMessage = {
                            image: { url: "https://files.catbox.moe/9gxtcc.jpg" },
                            caption: `> ᴀᴍ ᴀʟɪᴠᴇ ɴ ᴋɪᴄᴋɪɴɢ 🥳\n\n${captionText}`,
                            buttons: [
                                {
                                    buttonId: `${config.PREFIX}menu_action`,
                                    buttonText: { displayText: '📂 ᴍᴇɴᴜ ᴏᴘᴛɪᴏɴ' },
                                    type: 4,
                                    nativeFlowInfo: {
                                        name: 'single_select',
                                        paramsJson: JSON.stringify({
                                            title: 'ᴄʟɪᴄᴋ ʜᴇʀᴇ ❂',
                                            sections: [
                                                {
                                                    title: `generalkays-xᴍᴅ`,
                                                    highlight_label: 'Quick Actions',
                                                    rows: [
                                                        { title: '📋 ғᴜʟʟ ᴍᴇɴᴜ', description: 'ᴠɪᴇᴡ ᴀʟʟ ᴀᴠᴀɪʟᴀʙʟᴇ ᴄᴍᴅs', id: `${config.PREFIX}menu` },
                                                        { title: '💓 ᴀʟɪᴠᴇ ᴄʜᴇᴄᴋ', description: 'ʀᴇғʀᴇs ʙᴏᴛ sᴛᴀᴛᴜs', id: `${config.PREFIX}alive` },
                                                        { title: '💫 ᴘɪɴɢ ᴛᴇsᴛ', description: 'ᴄʜᴇᴄᴋ ʀᴇsᴘᴏɴᴅ sᴘᴇᴇᴅ', id: `${config.PREFIX}ping` }
                                                    ]
                                                },
                                                {
                                                    title: "ϙᴜɪᴄᴋ ᴄᴍᴅs",
                                                    highlight_label: 'Popular',
                                                    rows: [
                                                        { title: '🤖 ᴀɪ ᴄʜᴀᴛ', description: 'Start AI conversation', id: `${config.PREFIX}ai Hello!` },
                                                        { title: '🎵 ᴍᴜsɪᴄ sᴇᴀʀᴄʜ', description: 'Download your favorite songs', id: `${config.PREFIX}song` },
                                                        { title: '📰 ʟᴀᴛᴇsᴛ ɴᴇᴡs', description: 'Get current news updates', id: `${config.PREFIX}news` }
                                                    ]
                                                }
                                            ]
                                        })
                                    }
                                },
                                { buttonId: `${config.PREFIX}bot_info`, buttonText: { displayText: 'ℹ️ ʙᴏᴛ ɪɴғᴏ' }, type: 1 },
                                { buttonId: `${config.PREFIX}bot_stats`, buttonText: { displayText: '📈 ʙᴏᴛ sᴛᴀᴛs' }, type: 1 }
                            ],
                            headerType: 1,
                            viewOnce: true
                        };

                        await socket.sendMessage(m.chat, aliveMessage, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Alive command error:', error);
                        const startTime = socketCreationTime.get(number) || Date.now();
                        const uptime = Math.floor((Date.now() - startTime) / 1000);
                        const hours = Math.floor(uptime / 3600);
                        const minutes = Math.floor((uptime % 3600) / 60);
                        const seconds = Math.floor(uptime % 60);

                        await socket.sendMessage(m.chat, {
                            image: { url: "https://files.catbox.moe/9gxtcc.jpg" },
                            caption: `*🤖generalkays-xᴍᴅ ᴍɪɴɪ ᴀʟɪᴠᴇ*\n\n` +
                                    `╭────◉◉◉────៚\n` +
                                    `⏰ ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s\n` +
                                    `🟢 sᴛᴀᴛᴜs: ᴏɴʟɪɴᴇ\n` +
                                    `📱 ɴᴜᴍʙᴇʀ: ${number}\n` +
                                    `╰────◉◉◉────៚\n\n` +
                                    `Type *${config.PREFIX}menu* for commands`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: bot_stats
                case 'bot_stats': {
                    try {
                        const from = m.key.remoteJid;
                        const startTime = socketCreationTime.get(number) || Date.now();
                        const uptime = Math.floor((Date.now() - startTime) / 1000);
                        const hours = Math.floor(uptime / 3600);
                        const minutes = Math.floor((uptime % 3600) / 60);
                        const seconds = Math.floor(uptime % 60);
                        const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
                        const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
                        const activeCount = activeSockets.size;

                        const captionText = `
╭────◉◉◉────៚
📈 *BOT STATISTICS*
├─ ⏰ Uptime: ${hours}h ${minutes}m ${seconds}s
├─ 💾 Memory: ${usedMemory}MB / ${totalMemory}MB
├─ 👥 Active Users: ${activeCount}
├─ 🟢 Your Number: ${number}
├─ 🌐 Version: ${config.version}
╰────◉◉◉────៚`;

                        await socket.sendMessage(from, {
                            image: { url: "https://files.catbox.moe/9gxtcc.jpg" },
                            caption: captionText
                        }, { quoted: m });
                    } catch (error) {
                        console.error('Bot stats error:', error);
                        const from = m.key.remoteJid;
                        await socket.sendMessage(from, { text: '❌ Failed to retrieve stats. Please try again later.' }, { quoted: m });
                    }
                    break;
                }

                // Case: bot_info
                case 'bot_info': {
                    try {
                        const from = m.key.remoteJid;
                        const captionText = `
╭────◉◉◉────៚
🤖 *BOT INFORMATION*
├─ 👤 ɴᴀᴍᴇ: generalkays-ᴍᴅ-ᴍɪɴɪ
├─ 🇿🇼 ᴄʀᴇᴀᴛᴏʀ: generalkays ᴛᴇᴄʜ
├─ 🌐 ᴠᴇʀsɪᴏɴ: ${config.version}
├─ 📍 ᴘʀᴇғɪx: ${config.PREFIX}
├─ 📖 ᴅᴇsᴄ: ʏᴏᴜʀ cool,powerful wa bot here😘
╰────◉◉◉────៚`;

                        await socket.sendMessage(from, {
                            image: { url: "https://files.catbox.moe/9gxtcc.jpg" },
                            caption: captionText
                        }, { quoted: m });
                    } catch (error) {
                        console.error('Bot info error:', error);
                        const from = m.key.remoteJid;
                        await socket.sendMessage(from, { text: '❌ Failed to retrieve bot info.' }, { quoted: m });
                    }
                    break;
                }


// ᴄᴀsᴇ 2
                // Case: menu
                case 'menu': {
  try {
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    
    let menuText = `
*┌━━『 🤖 ʙᴏᴛ ɪɴғᴏ 』━━┐*   
*║ ▢ ᴜsᴇʀ: generalkays ᴛᴇᴄʜ*
*║ ▢ ᴘʀᴇғɪx: ${config.PREFIX}*
*║ ▢ *ᴍᴏᴅᴇ*: ${config.MODE}*
*║ ▢ ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s*
*║ ▢ ᴍᴇᴍᴏʀʏ: ${usedMemory} MB*
*║ ▢ ᴄᴍᴅs: ${count}*
*║ ▢ ᴏᴡɴᴇʀ: generalkays ᴛᴇᴄʜ*
*└━━━━━━━━━━━━━━━━┘*
> *🌐 ᴍɪɴɪ ᴡᴇʙsɪᴛᴇ*
- https://generalkays-mini-bot.onrender.com/

> *🔗 ᴄʜᴀɴɴᴇʟ ʟɪɴᴋ*
- https://whatsapp.com/channel/0029Vb8SoLw11ulLVkjqv140

> 🤖 ᴛʏᴘᴇ .ᴀʟʟᴍᴇɴᴜ ᴛᴏ ᴏᴛʜᴇʀ ᴄᴍᴅꜱ
`;

    const menuMessage = {
      image: { url: "https://files.catbox.moe/9gxtcc.jpg" },
      caption: `> 🔮 generalkays-xᴍᴅ ᴍɪɴɪ ᴍᴇɴᴜ 🔮\n${menuText}`,
      buttons: [
        {
          buttonId: `${config.PREFIX}quick_commands`,
          buttonText: { displayText: '🤖  generalkays-ᴍᴅ ᴍɪɴɪ ᴍᴇɴᴜ' },
          type: 4,
          nativeFlowInfo: {
            name: 'single_select',
            paramsJson: JSON.stringify({
              title: '🤖generalkaysᴍɪɴɪ ᴍᴇɴᴜ',
              sections: [
              {
                  
                  title: "🌐 ɢᴇɴᴇʀᴀʟ ᴄᴏᴍᴍᴀɴᴅs",
                  highlight_label: 'Popular',
                  rows: [
                    { title: "🟢 ᴀʟɪᴠᴇ", description: "Check if bot is active", id: `${config.PREFIX}alive` },
                    { title: "📊 ʙᴏᴛ sᴛᴀᴛs", description: "View bot statistics", id: `${config.PREFIX}bot_stats` },
                    { title: "ℹ️ ʙᴏᴛ ɪɴғᴏ", description: "Get bot information", id: `${config.PREFIX}bot_info` },
                    { title: "📋 ᴍᴇɴᴜ", description: "Show this menu", id: `${config.PREFIX}menu` },
                    { title: "📜 ᴀʟʟ ᴍᴇɴᴜ", description: "List all commands (text)", id: `${config.PREFIX}allmenu` },
                    { title: "🏓 ᴘɪɴɢ", description: "Check bot response speed", id: `${config.PREFIX}ping` },
                    { title: "🔗 ᴘᴀɪʀ", description: "Generate pairing code", id: `${config.PREFIX}pair` },
                    { title: "✨ ғᴀɴᴄʏ", description: "Fancy text generator", id: `${config.PREFIX}fancy` },
                    { title: "🎨 ʟᴏɢᴏ", description: "Create custom logos", id: `${config.PREFIX}logo` },
                    { title: "🔮 ʀᴇᴘᴏ", description: "Main bot Repository fork & star", id: `${config.PREFIX}repo` },
                    { title: "🤝 ʜᴇʟᴘ", description: "View help list", id: `${config.PREFIX}help` },
                  ]
                },
                {
                  title: "🎵 ᴍᴇᴅɪᴀ ᴛᴏᴏʟs",
                  highlight_label: 'New',
                  rows: [
                    { title: "🎵 sᴏɴɢ", description: "Download music from YouTube", id: `${config.PREFIX}song` },
                    { title: "🎶 sᴏɴɢ 2", description: "Download music from YouTube", id: `${config.PREFIX}song2` },
                    { title: "🎬 vɪᴅᴇᴏ", description: "Download video from YouTube", id: `${config.PREFIX}video` },
                    { title: "🎵 vɪᴅᴇᴏ", description: "Download video from YouTube", id: `${config.PREFIX}song2` },
                    { title: "🔞 xvɪᴅᴇᴏ", description: "Download video from YouTube", id: `${config.PREFIX}xvideo` },
                    { title: "📱 ᴛɪᴋᴛᴏᴋ", description: "Download TikTok videos", id: `${config.PREFIX}tiktok` },
                    { title: "📘 ғᴀᴄᴇʙᴏᴏᴋ", description: "Download Facebook content", id: `${config.PREFIX}fb` },
                    { title: "📘 ғᴀᴄᴇʙᴏᴏᴋ 2", description: "Download Facebook content", id: `${config.PREFIX}facebook` },
                    { title: "📸 ɪɴsᴛᴀɢʀᴀᴍ", description: "Download Instagram content", id: `${config.PREFIX}ig` },
                   { title: "📸 ɪɴsᴛᴀɢʀᴀᴍ 2", description: "Download Instagram content", id: `${config.PREFIX}ig2` },
                    { title: "🖼️ ᴀɪ ɪᴍɢ", description: "Generate AI images", id: `${config.PREFIX}aiimg` },
                    { title: "👀 ᴠɪᴇᴡᴏɴᴄᴇ", description: "Access view-once media [Not fixed]", id: `${config.PREFIX}vv` },
                    { title: "🗣️ ᴛᴛs", description: "Transcribe ", id: `${config.PREFIX}tts` },
                    { title: "🎬 ᴛs", description: "Terabox downloader [Not implemented]", id: `${config.PREFIX}ts` },
                    { title: "💻 yts", description: "Search video and songs from YouTube", id: `${config.PREFIX}yts` },
                    { title: "📽 movie", description: "search movie from web", id: `${config.PREFIX}movie` },
                    { title: "🖼️ sᴛɪᴄᴋᴇʀ", description: "Convert image/video to sticker [Not implemented]", id: `${config.PREFIX}sticker` }
                  ]
                },
                {
                  title: "🫂 ɢʀᴏᴜᴘ sᴇᴛᴛɪɴɢs",
                  highlight_label: 'Popular',
                  rows: [
                    { title: "➕ ᴀᴅᴅ", description: "Add Numbers to Group", id: `${config.PREFIX}add` },
                    { title: "🦶 ᴋɪᴄᴋ", description: "Remove Number from Group", id: `${config.PREFIX}kick` },
                    { title: "🔓 ᴏᴘᴇɴ", description: "Open Lock GROUP", id: `${config.PREFIX}open` },
                    { title: "🔒 ᴄʟᴏsᴇ", description: "Close Group", id: `${config.PREFIX}close` },
                    { title: "👑 ᴘʀᴏᴍᴏᴛᴇ", description: "Promote Member to Admin", id: `${config.PREFIX}promote` },
                    { title: "😢 ᴅᴇᴍᴏᴛᴇ", description: "Demote Member from Admin", id: `${config.PREFIX}demote` },
                    { title: "😢 ᴅeʟᴇᴛᴇ", description: "Delete a message", id: `${config.PREFIX}demote` },
                    { title: "😢 ᴊɪᴅ", description: "Get id", id: `${config.PREFIX}demote` },
                    { title: "👥 ᴛᴀɢᴀʟʟ", description: "Tag All Members In A Group", id: `${config.PREFIX}tagall` },
                    { title: "👤 ᴊᴏɪɴ", description: "Join A Group", id: `${config.PREFIX}join` }
                  ]
                },
                {
                  title: "📰 ɴᴇᴡs & ɪɴғᴏ",
                  highlight_label: 'New',
                  rows: [
                    { title: "📰 ɴᴇᴡs", description: "Get latest news updates", id: `${config.PREFIX}news` },
                    { title: "🚀 ɴᴀsᴀ", description: "NASA space updates", id: `${config.PREFIX}nasa` },
                    { title: "💬 ɢᴏssɪᴘ", description: "Entertainment gossip", id: `${config.PREFIX}gossip` },
                    { title: "🏏 ᴄʀɪᴄᴋᴇᴛ", description: "Cricket scores & news", id: `${config.PREFIX}cricket` },
                    { title: "🎭 ᴀɴᴏɴʏᴍᴏᴜs", description: "Fun interaction [Not implemented]", id: `${config.PREFIX}anonymous` }
                  ]
                },
                {
                  title: "🖤 ʀᴏᴍᴀɴᴛɪᴄ, sᴀᴠᴀɢᴇ & ᴛʜɪɴᴋʏ",
                  highlight_label: 'Refresh',
                  highlight_label: 'Fun',
                  rows: [
                    { title: "😂 ᴊᴏᴋᴇ", description: "Hear a lighthearted joke", id: `${config.PREFIX}joke` },
                    { title: "🌚 ᴅᴀʀᴋ ᴊᴏᴋᴇ", description: "Get a dark humor joke", id: `${config.PREFIX}darkjoke` },
                    { title: "🏏 ᴡᴀɪғᴜ", description: "Get a random anime waifu", id: `${config.PREFIX}waifu` },
                    { title: "😂 ᴍᴇᴍᴇ", description: "Receive a random meme", id: `${config.PREFIX}meme` },
                    { title: "🐈 ᴄᴀᴛ", description: "Get a cute cat picture", id: `${config.PREFIX}cat` },
                    { title: "🐕 ᴅᴏɢ", description: "See a cute dog picture", id: `${config.PREFIX}dog` },
                    { title: "💡 ғᴀᴄᴛ", description: "Learn a random fact", id: `${config.PREFIX}fact` },
                    { title: "💘 ᴘɪᴄᴋᴜᴘ ʟɪɴᴇ", description: "Get a cheesy pickup line", id: `${config.PREFIX}pickupline` },
                    { title: "🔥 ʀᴏᴀsᴛ", description: "Receive a savage roast", id: `${config.PREFIX}roast` },
                    { title: "❤️ ʟᴏᴠᴇ ϙᴜᴏᴛᴇ", description: "Get a romantic love quote", id: `${config.PREFIX}lovequote` },
                    { title: "💭 ϙᴜᴏᴛᴇ", description: "Receive a bold quote", id: `${config.PREFIX}quote` }
                  ]
                },
                {
                  title: "🔧 ᴛᴏᴏʟs & ᴜᴛɪʟɪᴛɪᴇs",
                  highlight_label: 'New',
                  rows: [
                    { title: "🤖 ᴀɪ", description: "Chat with AI assistant", id: `${config.PREFIX}ai` },
                    { title: "📊 ᴡɪɴғᴏ", description: "Get WhatsApp user info", id: `${config.PREFIX}winfo` },
                    { title: "🔍 ᴡʜᴏɪs", description: "Retrieve domain details", id: `${config.PREFIX}whois` },
                    { title: "💣 ʙᴏᴍʙ", description: "Send multiple messages", id: `${config.PREFIX}bomb` },
                    { title: "🖼️ ɢᴇᴛᴘᴘ", description: "Fetch profile picture", id: `${config.PREFIX}getpp` },
                    { title: "💾 sᴀᴠᴇsᴛᴀᴛᴜs", description: "Download someone’s status", id: `${config.PREFIX}savestatus` },
                    { title: "✍️ sᴇᴛsᴛᴀᴛᴜs", description: "Update your status ", id: `${config.PREFIX}setstatus` },
                    { title: "🗑️ ᴅᴇʟᴇᴛᴇ ᴍᴇ", description: "Remove your data ", id: `${config.PREFIX}deleteme` },
                    { title: "🌦️ ᴡᴇᴀᴛʜᴇʀ", description: "Get weather forecast", id: `${config.PREFIX}weather` },
                    { title: "🔗 sʜᴏʀᴛᴜʀʟ", description: "Create shortened URL", id: `${config.PREFIX}shorturl` },
                    { title: "📤 ᴜʀʟ", description: "Upload media to link", id: `${config.PREFIX}url` },
                    { title: "📦 ᴀᴘᴋ", description: "Download APK files", id: `${config.PREFIX}apk` },
                    { title: "📲 ғᴄ", description: "Follow a newsletter channel", id: `${config.PREFIX}fc` }
                    ]
                    },
                    {
                  title: "🎮 ɢᴀᴍᴇ ᴄᴍᴅs",
                  highlight_label: 'New',
                  rows: [
                    { title: " ᴛɪᴄᴛᴀᴄᴛᴏᴇ", description: "Start a new game", id: `${config.PREFIX}tictactoe` },
                    { title: "⏩ ᴍᴏᴠᴇ", description: "Move a <nimber>", id: `${config.PREFIX}move` },
                    { title: "❌ ϙᴜɪᴛɴ ɢᴀᴍᴇ", description: "End tictactoe game", id: `${config.PREFIX}quitgame` },
                    { title: "🕹️ ɢᴀᴍᴇ ᴍᴇɴᴜ ʟɪsᴛ", description: "View all game commands", id: `${config.PREFIX}gamemenu`}
                    
                  ]
                }
              ]
            })
          }
        },
        
        {
          buttonId: `${config.PREFIX}bot_stats`,
          buttonText: { displayText: 'ℹ️ ʙᴏᴛ sᴛᴀᴛs' },
          type: 1
        },
        {
          buttonId: `${config.PREFIX}bot_info`,
          buttonText: { displayText: '📈 ʙᴏᴛ ɪɴғᴏ' },
          type: 1
        }
      ],
      headerType: 1
    };
    await socket.sendMessage(from, menuMessage, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('Menu command error:', error);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    let fallbackMenuText = `
*┌━『 generalkays-ᴍᴅ ᴍᴇɴᴜ 』━┐*
*│ □* *Bot*: generalkays-xᴍᴅ-ᴍɪɴɪ
*│ □* *Prefix*: ${config.PREFIX}
*│ □* *Mode*: ${config.MODE}
*│ □* *Uptime*: ${hours}h ${minutes}m ${seconds}s
*│ □* *Memory*: ${usedMemory}MB/${totalMemory}MB
*└━━━━━━━━━━━━━━━━┘*

${config.PREFIX}allmenu ᴛᴏ ᴠɪᴇᴡ ᴀʟʟ ᴄᴍᴅs 
> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays ᴛᴇᴄʜ*
`;

    await socket.sendMessage(from, {
      image: { url: "https://files.catbox.moe/9gxtcc.jpg" },
      caption: fallbackMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}
// case 3 allmenu
case 'allmenu': case 'generalkays': {
  try {
    await socket.sendMessage(sender, { react: { text: '📜', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = (process.memoryUsage().heapUsed / 1024 / 1024);
      

    let allMenuText = `
╭━━━━━━━━━━━━━━━─⬣
┃  🤖 GENERALKAYS-XMD BOT      
╰━━━━━━━━━━━━━━━─⬣
╭──〔 📊 BOT INFO 〕──⬣
│ 👑 Owner   : generalkays Tech
│ 🌐 Prefix  : ${config.PREFIX}
│ ⚙️ Mode    : ${config.MODE}
│ ⏰ Uptime  : ${hours}h ${minutes}m ${seconds}s
│ 💾 RAM     : ${usedMemory} MB
│ 📦 Cmds    : ${count}
╰──────────────⬣

╭──〔 🌍 GENERAL 〕──⬣
│ 𖣘 ${config.PREFIX}alive
│ 𖣘 ${config.PREFIX}bot_info
│ 𖣘 ${config.PREFIX}bot_stats
│ 𖣘 ${config.PREFIX}menu
│ 𖣘 ${config.PREFIX}help
│ 𖣘 ${config.PREFIX}allmenu
│ 𖣘 ${config.PREFIX}ping
│ 𖣘 ${config.PREFIX}pair
│ 𖣘 ${config.PREFIX}jid
│ 𖣘 ${config.PREFIX}fancy
│ 𖣘 ${config.PREFIX}logo
│ 𖣘 ${config.PREFIX}qr
╰──────────────⬣

╭──〔 🎵 MEDIA 〕──⬣
│ 𖣘 ${config.PREFIX}song
│ 𖣘 ${config.PREFIX}song2
│ 𖣘 ${config.PREFIX}video
│ 𖣘 ${config.PREFIX}tiktok
│ 𖣘 ${config.PREFIX}facebook
│ 𖣘 ${config.PREFIX}ig
│ 𖣘 ${config.PREFIX}aiimg
│ 𖣘 ${config.PREFIX}viewonce
│ 𖣘 ${config.PREFIX}tts
│ 𖣘 ${config.PREFIX}sticker
╰──────────────⬣

╭──〔 👥 GROUP 〕──⬣
│ 𖣘 ${config.PREFIX}add
│ 𖣘 ${config.PREFIX}kick
│ 𖣘 ${config.PREFIX}promote
│ 𖣘 ${config.PREFIX}demote
│ 𖣘 ${config.PREFIX}open
│ 𖣘 ${config.PREFIX}close
│ 𖣘 ${config.PREFIX}tagall
│ 𖣘 ${config.PREFIX}delete
│ 𖣘 ${config.PREFIX}join
╰──────────────⬣

╭──〔 🎭 FUN 〕──⬣
│ 𖣘 ${config.PREFIX}joke
│ 𖣘 ${config.PREFIX}darkjoke
│ 𖣘 ${config.PREFIX}meme
│ 𖣘 ${config.PREFIX}waifu
│ 𖣘 ${config.PREFIX}cat
│ 𖣘 ${config.PREFIX}dog
│ 𖣘 ${config.PREFIX}fact
│ 𖣘 ${config.PREFIX}quote
│ 𖣘 ${config.PREFIX}roast
╰──────────────⬣

╭──〔 🛠️ UTILITIES 〕──⬣
│ 𖣘 ${config.PREFIX}ai
│ 𖣘 ${config.PREFIX}weather
│ 𖣘 ${config.PREFIX}whois
│ 𖣘 ${config.PREFIX}winfo
│ 𖣘 ${config.PREFIX}shorturl
│ 𖣘 ${config.PREFIX}url
│ 𖣘 ${config.PREFIX}apk
│ 𖣘 ${config.PREFIX}fc
│ 𖣘 ${config.PREFIX}getpp
│ 𖣘 ${config.PREFIX}savestatus
│ 𖣘 ${config.PREFIX}setstatus
╰──────────────⬣

> *powered by generalkays-xᴍᴅ ᴍɪɴɪ*
`;

    await socket.sendMessage(from, {
      image: { url: "https://files.catbox.moe/9gxtcc.jpg" },
      caption: allMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌ *Oh, darling, the menu got shy! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}

                // Case: fc (follow channel)
                case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363419693990894@newsletter'
                        });
                    }

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                    await socket.sendMessage(sender, { react: { text: '😌', key: msg.key } });
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }

//=================================
case 'help': {
  try {
    await socket.sendMessage(sender, { react: { text: '📜', key: msg.key } });
    
    let allMenuText = `
    
\`HELP INFO 🙃\`
 
 *🤖 ɴᴀᴍᴇ*: generalkays-ᴍᴅ ᴍɪɴɪ
 
 📍 *ᴘʀᴇғɪx*: ${config.PREFIX}
 🔮 *ᴍᴏᴅᴇ*: ${config.MODE}

╭─『 🌐 *ɢᴇɴᴇʀᴀʟ ᴄᴍᴅs* 』─╮
│ 🟢 *1. \`alive\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄʜᴇᴄᴋ ʙᴏᴛ sᴛᴀᴛᴜs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴀʟɪᴠᴇ
│
│ 📊 *2. \`bot_stats\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʙᴏᴛ sᴛᴀᴛɪsᴛɪᴄs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ʙᴏᴛ_sᴛᴀᴛs
│
│ ℹ️ *3. \`bot_info\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʙᴏᴛ ɪɴꜰᴏʀᴍᴀᴛɪᴏɴ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ʙᴏᴛ_ɪɴꜰᴏ
│
│ 📋 *4. \`menu\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: sʜᴏᴡ ɪɴᴛᴇʀᴀᴄᴛɪᴠᴇ ᴍᴇɴᴜ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴍᴇɴᴜ
│
│ 📜 *5. \`allmenu\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʟɪsᴛ ᴀʟʟ ᴄᴏᴍᴍᴀɴᴅs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴀʟʟᴍᴇɴᴜ
│
│ 🏓 *6. \`ping\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄʜᴇᴄᴋ ʀᴇsᴘᴏɴsᴇ sᴘᴇᴇᴅ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴘɪɴɢ
│
│ 🔗 *7. \`pair\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ɢᴇɴᴇʀᴀᴛᴇ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴘᴀɪʀ
│
│ ✨ *8. \`fancy\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ꜰᴀɴᴄʏ ᴛᴇxᴛ ɢᴇɴᴇʀᴀᴛᴏʀ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ꜰᴀɴᴄʏ <text>
│
│ 🎨 *9. \`logo\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄʀᴇᴀᴛᴇ ᴄᴜsᴛᴏᴍ ʟᴏɢᴏs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ʟᴏɢᴏ <style>
│
│ 📱 *10. \`qr\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ɢᴇɴᴇʀᴀᴛᴇ Qʀ ᴄᴏᴅᴇs 
│   - ᴜsᴀɢᴇ: ${config.PREFIX}Qʀ <text>
╰────────────

╭─『 🎵 *ᴍᴇᴅɪᴀ ᴛᴏᴏʟs* 』─╮
│ 🎵 *1. \`song\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴏᴡɴʟᴏᴀᴅ ʏᴏᴜᴛᴜʙᴇ ᴍᴜsɪᴄ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}sᴏɴɢ <url>
│
│ 📱 *2. \`tiktok\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴏᴡɴʟᴏᴀᴅ ᴛɪᴋᴛᴏᴋ ᴠɪᴅᴇᴏs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴛɪᴋᴛᴏᴋ <url>
│
│ 📘 *3. \`fb\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴏᴡɴʟᴏᴀᴅ ꜰᴀᴄᴇʙᴏᴏᴋ ᴄᴏɴᴛᴇɴᴛ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ꜰʙ <url>
│
│ 📸 *4. \`ig\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴏᴡɴʟᴏᴀᴅ ɪɴsᴛᴀɢʀᴀᴍ ᴄᴏɴᴛᴇɴᴛ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ɪɢ <url>
│
│ 🖼️ *5. \`aiimg\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ɢᴇɴᴇʀᴀᴛᴇ ᴀɪ ɪᴍᴀɢᴇs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴀɪɪᴍɢ <prompt>
│
│ 👀 *6. \`viewonce\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴠɪᴇᴡ ᴏɴᴄᴇ ᴍᴇᴅɪᴀ (ᴀʟsᴏ .ʀᴠᴏ, .ᴠᴠ)
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴠɪᴇᴡᴏɴᴄᴇ
│
│ 🗣️ *7. \`tts\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴛʀᴀɴsᴄʀɪʙᴇ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴛᴛs <text>
│
│ 🎬 *8. \`ts\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴛᴇʀᴀʙᴏx ᴅᴏᴡɴʟᴏᴀᴅᴇʀ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴛs <url>
│
│ 🖼️ *9. \`sticker\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄᴏɴᴠᴇʀᴛ ᴛᴏ sᴛɪᴄᴋᴇʀ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]
│   - ᴜsᴀɢᴇ: ${config.PREFIX}sᴛɪᴄᴋᴇʀ <image>
╰─────────────

╭─『 🫂 *ɢʀᴏᴜᴘ sᴇᴛᴛɪɴɢs* 』─╮
│ ➕ *1. \`add\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴀᴅᴅ ᴍᴇᴍʙᴇʀ ᴛᴏ ɢʀᴏᴜᴘ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴀᴅᴅ <number>
│
│ 🦶 *2. \`kick\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʀᴇᴍᴏᴠᴇ ᴍᴇᴍʙᴇʀ ꜰʀᴏᴍ ɢʀᴏᴜᴘ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴋɪᴄᴋ <number>
│
│ 🔓 *3. \`open\`*
│   - ᴄᴜʀʀᴇɴᴛ: ${config.GROUP_OPEN}
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴜɴʟᴏᴄᴋ ɢʀᴏᴜᴘ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴏᴘᴇɴ
│
│ 🔒 *4. \`close\`*
│   - ᴄᴜʀʀᴇɴᴛ: ${config.GROUP_OPEN}
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʟᴏᴄᴋ ɢʀᴏᴜᴘ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴄʟᴏsᴇ
│
│ 👑 *5. \`promote\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴘʀᴏᴍᴏᴛᴇ ᴛᴏ ᴀᴅᴍɪɴ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴘʀᴏᴍᴏᴛᴇ <number>
│
│ 😢 *6. \`demote\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴇᴍᴏᴛᴇ ꜰʀᴏᴍ ᴀᴅᴍɪɴ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴅᴇᴍᴏᴛᴇ <number>
│
│ 👥 *7. \`tagall\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴛᴀɢ ᴀʟʟ ᴍᴇᴍʙᴇʀs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴛᴀɢᴀʟʟ
│
│ 👤 *8. \`join\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴊᴏɪɴ ɢʀᴏᴜᴘ ᴠɪᴀ ʟɪɴᴋ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴊᴏɪɴ <link>
╰────────────

╭─『 📰 *ɴᴇᴡs & ɪɴꜰᴏ* 』─╮
│ 📰 *1. \`news\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʟᴀᴛᴇsᴛ ɴᴇᴡs ᴜᴘᴅᴀᴛᴇs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ɴᴇᴡs
│
│ 🚀 *2. \`nasa\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ɴᴀsᴀ sᴘᴀᴄᴇ ᴜᴘᴅᴀᴛᴇs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ɴᴀsᴀ
│
│ 💬 *3. \`gossip\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴇɴᴛᴇʀᴛᴀɪɴᴍᴇɴᴛ ɢᴏssɪᴘ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ɢᴏssɪᴘ
│
│ 🏏 *4. \`cricket\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄʀɪᴄᴋᴇᴛ sᴄᴏʀᴇs & ɴᴇᴡs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴄʀɪᴄᴋᴇᴛ
│
│ 🎭 *5. \`anonymous\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ꜰᴜɴ ɪɴᴛᴇʀᴀᴄᴛɪᴏɴ 
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴀɴᴏɴʏᴍᴏᴜs
╰─────────────

╭─『 🖤 *ʀᴏᴍᴀɴᴛɪᴄ, sᴀᴠᴀɢᴇ & ᴛʜɪɴᴋʏ* 』─╮
│ 😂 *1. \`joke\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʟɪɢʜᴛʜᴇᴀʀᴛᴇᴅ ᴊᴏᴋᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴊᴏᴋᴇ
│
│ 🌚 *2. \`darkjoke\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴀʀᴋ ʜᴜᴍᴏʀ ᴊᴏᴋᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴅᴀʀᴋᴊᴏᴋᴇ
│
│ 🏏 *3. \`waifu\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʀᴀɴᴅᴏᴍ ᴀɴɪᴍᴇ ᴡᴀɪꜰᴜ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴡᴀɪꜰᴜ
│
│ 😂 *4. \`meme\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʀᴀɴᴅᴏᴍ ᴍᴇᴍᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴍᴇᴍᴇ
│
│ 🐈 *5. \`cat\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄᴜᴛᴇ ᴄᴀᴛ ᴘɪᴄᴛᴜʀᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴄᴀᴛ
│
│ 🐕 *6. \`dog\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄᴜᴛᴇ ᴅᴏɢ ᴘɪᴄᴛᴜʀᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴅᴏɢ
│
│ 💡 *7. \`fact\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʀᴀɴᴅᴏᴍ ꜰᴀᴄᴛ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ꜰᴀᴄᴛ
│
│ 💘 *8. \`pickupline\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄʜᴇᴇsʏ ᴘɪᴄᴋᴜᴘ ʟɪɴᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴘɪᴄᴋᴜᴘʟɪɴᴇ
│
│ 🔥 *9. \`roast\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: sᴀᴠᴀɢᴇ ʀᴏᴀsᴛ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ʀᴏᴀsᴛ
│
│ ❤️ *10. \`lovequote\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʀᴏᴍᴀɴᴛɪᴄ ʟᴏᴠᴇ Qᴜᴏᴛᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ʟᴏᴠᴇQᴜᴏᴛᴇ
│
│ 💭 *11. \`quote\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ʙᴏʟᴅ ᴏʀ ᴡɪᴛᴛʏ Qᴜᴏᴛᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}Qᴜᴏᴛᴇ
╰──────────────

╭─『 🔧 *ᴛᴏᴏʟs & ᴜᴛɪʟɪᴛɪᴇs* 』─╮
│ 🤖 *1. \`ai\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄʜᴀᴛ ᴡɪᴛʜ ᴀɪ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴀɪ <query>
│
│ 📊 *2. \`winfo\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴡʜᴀᴛsᴀᴘᴘ ᴜsᴇʀ ɪɴꜰᴏ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴡɪɴꜰᴏ <number>
│
│ 🔍 *3. \`whois\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴏᴍᴀɪɴ ᴡʜᴏɪs ʟᴏᴏᴋᴜᴘ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴡʜᴏɪs <domain>
│
│ 💣 *4. \`bomb\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: sᴇɴᴅ ᴍᴜʟᴛɪᴘʟᴇ ᴍᴇssᴀɢᴇs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ʙᴏᴍʙ <number> <count>
│
│ 🖼️ *5. \`getpp\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ꜰᴇᴛᴄʜ ᴘʀᴏꜰɪʟᴇ ᴘɪᴄᴛᴜʀᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ɢᴇᴛᴘᴘ <number>
│
│ 💾 *6. \`savestatus\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: sᴀᴠᴇ sᴛᴀᴛᴜs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}sᴀᴠᴇsᴛᴀᴛᴜs
│
│ ✍️ *7. \`setstatus\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: sᴇᴛ sᴛᴀᴛᴜs [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]
│   - ᴜsᴀɢᴇ: ${config.PREFIX}sᴇᴛsᴛᴀᴛᴜs <text>
│
│ 🗑️ *8. \`deleteme\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴇʟᴇᴛᴇ ᴜsᴇʀ ᴅᴀᴛᴀ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴅᴇʟᴇᴛᴇᴍᴇ
│
│ 🌦️ *9. \`weather\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴡᴇᴀᴛʜᴇʀ ꜰᴏʀᴇᴄᴀsᴛ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴡᴇᴀᴛʜᴇʀ <location>
│
│ 🔗 *10. \`shorturl\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: sʜᴏʀᴛᴇɴ ᴜʀʟ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}sʜᴏʀᴛᴜʀʟ <url>
│
│ 📤 *11. \`tourl2\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴜᴘʟᴏᴀᴅ ᴍᴇᴅɪᴀ ᴛᴏ ʟɪɴᴋ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴛᴏᴜʀʟ2 <media>
│
│ 📦 *12. \`apk\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅᴏᴡɴʟᴏᴀᴅ ᴀᴘᴋ ꜰɪʟᴇs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴀᴘᴋ <app_name>
│
│ 📲 *13. \`fc\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ꜰᴏʟʟᴏᴡ ɴᴇᴡsʟᴇᴛᴛᴇʀ ᴄʜᴀɴɴᴇʟ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ꜰᴄ <channel>
╰──────────────

> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays ᴛᴇᴄʜ*
`;

    await socket.sendMessage(from, {
      image: { url: "https://files.catbox.moe/9gxtcc.jpg" },
      caption: allMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('help command error:', error);
    await socket.sendMessage(from, {
      text: `❌ *ᴏʜ, ᴅᴀʀʟɪɴɢ, ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ!* 😢\nᴇʀʀᴏʀ: ${error.message || 'ᴜɴᴋɴᴏᴡɴ ᴇʀʀᴏʀ'}\nᴛʀʏ ᴀɢᴀɪɴ, ʟᴏᴠᴇ?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}
//==============================

                // Case: ping
                case 'ping': {
                await socket.sendMessage(sender, { react: { text: '📍', key: msg.key } });
                    try {
                        const startTime = new Date().getTime();
                        let ping = await socket.sendMessage(sender, { text: '*_🏓 ᴘɪɴɢɪɴɢ ᴛᴏ sᴇʀᴠᴇʀ..._* ❗' }, { quoted: msg });

                        const progressSteps = [
                            { bar: '《 █▒▒▒▒▒▒▒▒▒▒▒》', percent: '10%', delay: 100 },
                            { bar: '《 ███▒▒▒▒▒▒▒▒▒》', percent: '25%', delay: 150 },
                            { bar: '《 █████▒▒▒▒▒▒▒》', percent: '40%', delay: 100 },
                            { bar: '《 ███████▒▒▒▒▒》', percent: '55%', delay: 120 },
                            { bar: '《 █████████▒▒▒》', percent: '70%', delay: 100 },
                            { bar: '《 ███████████▒》', percent: '85%', delay: 100 },
                            { bar: '《 ████████████》', percent: '100%', delay: 200 }
                        ];

                        for (let step of progressSteps) {
                            await new Promise(resolve => setTimeout(resolve, step.delay));
                            try {
                                await socket.sendMessage(sender, { text: `${step.bar} ${step.percent}`, edit: ping.key });
                            } catch (editError) {
                                console.warn('Failed to edit message:', editError);
                                ping = await socket.sendMessage(sender, { text: `${step.bar} ${step.percent}` }, { quoted: msg });
                            }
                        }

                        const endTime = new Date().getTime();
                        const latency = endTime - startTime;

                        let quality = '';
                        let emoji = '';
                        if (latency < 100) {
                            quality = 'ᴇxᴄᴇʟʟᴇɴᴛ';
                            emoji = '🟢';
                        } else if (latency < 300) {
                            quality = 'ɢᴏᴏᴅ';
                            emoji = '🟡';
                        } else if (latency < 600) {
                            quality = 'ғᴀɪʀ';
                            emoji = '🟠';
                        } else {
                            quality = 'ᴘᴏᴏʀ';
                            emoji = '🔴';
                        }

                        const finalMessage = {
                            text: `🏓 *ᴘɪɴɢ!*\n\n` +
                                `⚡ *sᴘᴇᴇᴅ:* ${latency}ms\n` +
                                `${emoji} *ϙᴜᴀʟɪᴛʏ:* ${quality}\n` +
                                `🕒 *ᴛɪᴍᴇsᴛᴀᴍᴘ:* ${new Date().toLocaleString('en-US', { timeZone: 'UTC', hour12: true })}\n\n` +
                                `╭──────────\n` +
                                `│   ᴄᴏɴɴᴇᴄᴛɪᴏɴ sᴛᴀᴛᴜs  \n` +
                                `╰──────────`,
                            buttons: [
                                { buttonId: `${prefix}bot_info`, buttonText: { displayText: '🔎 ʙᴏᴛ ɪɴғᴏ 🔍' }, type: 1 },
                                { buttonId: `${prefix}bot_stats`, buttonText: { displayText: '📊 ʙᴏᴛ sᴛᴀᴛs 📊' }, type: 1 }
                            ],
                            headerType: 4
                        };

                        await socket.sendMessage(sender, finalMessage, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Ping command error:', error);
                        const startTime = new Date().getTime();
                        const simplePing = await socket.sendMessage(sender, { text: '📍 Calculating ping...' }, { quoted: msg });
                        const endTime = new Date().getTime();
                        await socket.sendMessage(sender, { text: `📌 *Pong!*\n⚡ Latency: ${endTime - startTime}ms` }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: pair
                case 'pair': {
                await socket.sendMessage(sender, { react: { text: '📲', key: msg.key } });
                    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                    const q = msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            msg.message?.imageMessage?.caption ||
                            msg.message?.videoMessage?.caption || '';

                    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

                    if (!number) {
                        return await socket.sendMessage(sender, {
                            text: '*📌 Usage:* .pair +263xxxx'
                        }, { quoted: msg });
                    }

                    try {
                        const url = `https://generalkays-mini-pair.zone.id/code?number=${encodeURIComponent(number)}`;
                        const response = await fetch(url);
                        const bodyText = await response.text();

                        console.log("🌐 API Response:", bodyText);

                        let result;
                        try {
                            result = JSON.parse(bodyText);
                        } catch (e) {
                            console.error("❌ JSON Parse Error:", e);
                            return await socket.sendMessage(sender, {
                                text: '❌ Invalid response from server. Please contact support.'
                            }, { quoted: msg });
                        }

                        if (!result || !result.code) {
                            return await socket.sendMessage(sender, {
                                text: '❌ Failed to retrieve pairing code. Please check the number.'
                            }, { quoted: msg });
                        }

                        await socket.sendMessage(sender, {
                            text: `> *generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ ᴘᴀɪʀ ᴄᴏᴍᴘʟᴇᴛᴇᴅ* ✅\n\n*🔑 Your pairing code is:* ${result.code}`
                        }, { quoted: msg });

                        await sleep(2000);

                        await socket.sendMessage(sender, {
                            text: `${result.code}`
                        }, { quoted: fakevCard });

                    } catch (err) {
                        console.error("❌ Pair Command Error:", err);
                        await socket.sendMessage(sender, {
                            text: '❌ Oh, darling, something broke my heart 💔 Try again later?'
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: viewonce



                // Case: song
                case 'song2': {
                await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
                    const yts = require('yt-search');
                    const ddownr = require('denethdev-ytmp3');
                    const fs = require('fs');
                    const path = require('path');
                    const { exec } = require('child_process');
                    const util = require('util');
                    const execPromise = util.promisify(exec);

                    const tempDir = './temp';
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }

                    function extractYouTubeId(url) {
                        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
                        const match = url.match(regex);
                        return match ? match[1] : null;
                    }

                    function convertYouTubeLink(input) {
                        const videoId = extractYouTubeId(input);
                        if (videoId) {
                            return `https://www.youtube.com/watch?v=${videoId}`;
                        }
                        return input;
                    }

                    async function compressAudio(inputPath, outputPath, targetSizeMB = 3.8) {
                        try {
                            const { stdout: durationOutput } = await execPromise(
                                `ffprobe -i "${inputPath}" -show_entries format=duration -v quiet -of csv="p=0"`
                            );
                            const duration = parseFloat(durationOutput) || 180;
                            const targetBitrate = Math.floor((targetSizeMB * 8192) / duration);
                            const constrainedBitrate = Math.min(Math.max(targetBitrate, 32), 128);
                            console.log(`Compressing audio: Duration=${duration}s, Target bitrate=${constrainedBitrate}kbps`);
                            await execPromise(
                                `ffmpeg -i "${inputPath}" -b:a ${constrainedBitrate}k -vn -y "${outputPath}"`
                            );
                            return true;
                        } catch (error) {
                            console.error('Audio compression failed:', error);
                            return false;
                        }
                    }

                    const q = msg.message?.conversation || 
                            msg.message?.extendedTextMessage?.text || 
                            msg.message?.imageMessage?.caption || 
                            msg.message?.videoMessage?.caption || '';

                    if (!q || q.trim() === '') {
                        return await socket.sendMessage(sender, { text: '*`Give me a song title or YouTube link, love 😘`*' }, { quoted: fakevCard });
                    }

                    const fixedQuery = convertYouTubeLink(q.trim());
                    let tempFilePath = '';
                    let compressedFilePath = '';

                    try {
                        await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });
                        const search = await yts(fixedQuery);
                        const data = search.videos[0];
                        if (!data) {
                            return await socket.sendMessage(sender, { text: '*`No songs found, darling! Try another? 💔`*' }, { quoted: fakevCard });
                        }

                        const url = data.url;
                        const desc = `
🎵 *𝚃𝚒𝚝𝚕𝚎 :* \`${data.title}\`

◆⏱️ *𝙳𝚞𝚛𝚊𝚝𝚒𝚘𝚗* : ${data.timestamp} 

◆ *𝚅𝚒𝚎𝚠𝚜* : ${data.views.toLocaleString()}

◆ 📅 *𝚁𝚎𝚕𝚎𝚊𝚜 𝙳𝚊𝚝𝚎* : ${data.ago}

> ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays-ᴍɪɴɪ ʙᴏᴛ
🔗 join channel: https://whatsapp.com/channel/0029Vb8SoLw11ulLVkjqv140

`;

                        await socket.sendMessage(sender, {
                            image: { url: data.thumbnail },
                            caption: desc,
                        }, { quoted: fakevCard });

                        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
                        await socket.sendMessage(sender, { text: '*📥 Downloading your song, please wait...*' }, { quoted: fakevCard });

                        const result = await ddownr.download(url, 'mp3');
                        const downloadLink = result.downloadUrl;

                        const cleanTitle = data.title.replace(/[^\w\s]/gi, '').substring(0, 30);
                        tempFilePath = path.join(tempDir, `${cleanTitle}_${Date.now()}_original.mp3`);
                        compressedFilePath = path.join(tempDir, `${cleanTitle}_${Date.now()}_compressed.mp3`);

                        const response = await fetch(downloadLink);
                        const arrayBuffer = await response.arrayBuffer();
                        fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));

                        const stats = fs.statSync(tempFilePath);
                        const fileSizeMB = stats.size / (1024 * 1024);
                        
                        if (fileSizeMB > 4) {
                            await socket.sendMessage(sender, { text: '*⚡ Compressing audio to optimal size...*' }, { quoted: fakevCard });
                            const compressionSuccess = await compressAudio(tempFilePath, compressedFilePath);
                            if (compressionSuccess) {
                                tempFilePath = compressedFilePath;
                                await socket.sendMessage(sender, { text: '*✅ Audio compressed successfully!*' }, { quoted: fakevCard });
                            } else {
                                await socket.sendMessage(sender, { text: '*⚠️ Using original audio (compression failed)*' }, { quoted: fakevCard });
                            }
                        }

                        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

                        await socket.sendMessage(sender, {
                            audio: fs.readFileSync(tempFilePath),
                            mimetype: "audio/mpeg",
                            fileName: `${cleanTitle}.mp3`,
                            ptt: false
                        }, { quoted: fakevCard });

                        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                        if (compressedFilePath && fs.existsSync(compressedFilePath)) fs.unlinkSync(compressedFilePath);
                        
                        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    } catch (err) {
                        console.error('Song command error:', err);
                        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                        if (compressedFilePath && fs.existsSync(compressedFilePath)) fs.unlinkSync(compressedFilePath);
                        await socket.sendMessage(sender, { text: "*❌ Oh no, the music stopped, love! 😢 Try again?*" }, { quoted: fakevCard });
                    }
                    break;
                }
                
   case 'song': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    // ✅ Extract YouTube ID from different types of URLs
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    // ✅ Convert YouTube shortened/invalid links to proper watch URL
    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return input; // If not a URL, assume it's a search query
    }

    // ✅ Get message text or quoted text
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
╔═════════════════╗
🎵  *ɴᴏᴡ ᴘʟᴀʏɪɴɢ* 🎵
╚═════════════════╝
╭
╠☪ 🎶 *ᴛɪᴛᴛʟᴇ:* ${data.title}
╟☪ 📅 *ʀᴇʟᴇᴀsᴇ ᴅᴀᴛᴇ:* ${data.timestamp}
╟☪ ⏱️ *ᴅᴜʀᴀᴛɪᴏɴ:* ${data.ago}
╰
───────────────
> ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ
🔗 Join Channel: https://whatsapp.com/channel/0029Vb8SoLw11ulLVkjqv140

`;

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc,
        }, { quoted: fakevCard });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            audio: { url: downloadLink },
            mimetype: "audio/mpeg",
            ptt: true
        }, { quoted: fakevCard });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`❌ Oh, sweetie, that song slipped away! Try again? 💔`*" });
    }
                      break;
                }
                       
                  case 'video': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    // ✅ Extract YouTube ID from different types of URLs
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    // ✅ Convert YouTube shortened/invalid links to proper watch URL
    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return input; // If not a URL, assume it's a search query
    }

    // ✅ Get message text or quoted text
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
╔═════════════════╗
🎵  *ɴᴏᴡ ᴘʟᴀʏɪɴɢ* 🎵
╚═════════════════╝
╭
╠☪ 🎶 *ᴛɪᴛᴛʟᴇ:* ${data.title}
╟☪ 📅 *ʀᴇʟᴇᴀsᴇ ᴅᴀᴛᴇ:* ${data.timestamp}
╟☪ ⏱️ *ᴅᴜʀᴀᴛɪᴏɴ:* ${data.ago}
╰
───────────────
> ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays-ᴍᴅ ᴍɪɴɪ ʙot
join channel: https://whatsapp.com/channel/0029Vb8SoLw11ulLVkjqv140

`;

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc,
        }, { quoted: fakevCard });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            video: { url: downloadLink },
            mimetype: "video/mp4",
        }, { quoted: fakevCard });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
    }
 break;
        }             
                               
//===============================   
  case 'logo': { 
                    const q = args.join(" ");
                    
                    
                    if (!q || q.trim() === '') {
                        return await socket.sendMessage(sender, { text: '*`Need a name for logo, darling 😘`*' });
                    }

                    await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
                    const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

                    const rows = list.data.map((v) => ({
                        title: v.name,
                        description: 'Tap to generate logo',
                        id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
                    }));
                    
                    const buttonMessage = {
                        buttons: [
                            {
                                buttonId: 'action',
                                buttonText: { displayText: '🎨 Select Text Effect' },
                                type: 4,
                                nativeFlowInfo: {
                                    name: 'single_select',
                                    paramsJson: JSON.stringify({
                                        title: 'Available Text Effects',
                                        sections: [
                                            {
                                                title: 'Choose your logo style',
                                                rows
                                            }
                                        ]
                                    })
                                }
                            }
                        ],
                        headerType: 1,
                        viewOnce: true,
                        caption: '❏ *LOGO MAKER*',
                        image: { url: 'https://files.catbox.moe/9gxtcc.jpg' },
                    };

                    await socket.sendMessage(from, buttonMessage, { quoted: fakevCard });
                    break;
                }
//===============================                
// 9
                case 'dllogo': { 
                await socket.sendMessage(sender, { react: { text: '🔋', key: msg.key } });
                    const q = args.join(" "); 
                    
                    if (!q) return await socket.sendMessage(from, { text: "Please give me a URL to capture the screenshot, love 😘" }, { quoted: fakevCard });
                    
                    try {
                        const res = await axios.get(q);
                        const images = res.data.result.download_url;

                        await socket.sendMessage(m.chat, {
                            image: { url: images },
                            caption: config.CAPTION
                        }, { quoted: msg });
                    } catch (e) {
                        console.log('Logo Download Error:', e);
                        await socket.sendMessage(from, {
                            text: `❌ Oh, sweetie, something went wrong with the logo... 💔 Try again?`
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                               
//===============================
                case 'fancy': {
                await socket.sendMessage(sender, { react: { text: '🖋', key: msg.key } });
                    const axios = require("axios");
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const text = q.trim().replace(/^.fancy\s+/i, "");

                    if (!text) {
                        return await socket.sendMessage(sender, {
                            text: "❎ *Give me some text to make it fancy, sweetie 😘*\n\n📌 *Example:* `.fancy Malvin`"
                        });
                    }

                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data.status || !response.data.result) {
                            return await socket.sendMessage(sender, {
                                text: "❌ *Oh, darling, the fonts got shy! Try again later? 💔*"
                            });
                        }

                        const fontList = response.data.result
                            .map(font => `*${font.name}:*\n${font.result}`)
                            .join("\n\n");

                        const finalMessage = `🎨 *Fancy Fonts Converter*\n\n${fontList}\n\n_ᴘᴏᴡᴇʀᴇᴅ iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ`;

                        await socket.sendMessage(sender, {
                            text: finalMessage
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error("Fancy Font Error:", err);
                        await socket.sendMessage(sender, {
                            text: "⚠️ *Something went wrong with the fonts, love 😢 Try again?*"
                        });
                    }
                    break;
                    }
                
case 'tiktok': {
const axios = require('axios');

// Optimized axios instance
const axiosInstance = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
});

// TikTok API configuration
const TIKTOK_API_KEY = process.env.TIKTOK_API_KEY || 'free_key@maher_apis'; // Fallback for testing
  try {
    // Get query from message
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    // Validate and sanitize URL
    const tiktokUrl = q.trim();
    const urlRegex = /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com)\/[@a-zA-Z0-9_\-\.\/]+/;
    if (!tiktokUrl || !urlRegex.test(tiktokUrl)) {
      await socket.sendMessage(sender, {
        text: '📥 *Usage:* .tiktok <TikTok URL>\nExample: .tiktok https://www.tiktok.com/@user/video/123456789'
      }, { quoted: fakevCard });
      return;
    }

    // Send downloading reaction
    try {
      await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    } catch (reactError) {
      console.error('Reaction error:', reactError);
    }

    // Try primary API
    let data;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
      const res = await axiosInstance.get(`https://api.nexoracle.com/downloader/tiktok-nowm?apikey=${TIKTOK_API_KEY}&url=${encodeURIComponent(tiktokUrl)}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.data?.status === 200) {
        data = res.data.result;
      }
    } catch (primaryError) {
      console.error('Primary API error:', primaryError.message);
    }

    // Fallback API
    if (!data) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
        const fallback = await axiosInstance.get(`https://api.tikwm.com/?url=${encodeURIComponent(tiktokUrl)}&hd=1`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (fallback.data?.data) {
          const r = fallback.data.data;
          data = {
            title: r.title || 'No title',
            author: {
              username: r.author?.unique_id || 'Unknown',
              nickname: r.author?.nickname || 'Unknown'
            },
            metrics: {
              digg_count: r.digg_count || 0,
              comment_count: r.comment_count || 0,
              share_count: r.share_count || 0,
              download_count: r.download_count || 0
            },
            url: r.play || '',
            thumbnail: r.cover || ''
          };
        }
      } catch (fallbackError) {
        console.error('Fallback API error:', fallbackError.message);
      }
    }

    if (!data || !data.url) {
      await socket.sendMessage(sender, { text: '❌ TikTok video not found.' }, { quoted: fakevCard });
      return;
    }

    const { title, author, url, metrics, thumbnail } = data;

    // Prepare caption
    const caption = `
╭──『 🎬 𝚃𝚒𝚔𝚃𝚘𝚔 𝙳𝚘𝚠𝚗𝚕𝚘𝚊𝚍𝚎𝚛 』─
│
│ 📝 ᴛɪᴛᴛʟᴇ: ${title.replace(/[<>:"\/\\|?*]/g, '')}
│ 👤 ᴀᴜᴛʜᴏʀ: @${author.username.replace(/[<>:"\/\\|?*]/g, '')} (${author.nickname.replace(/[<>:"\/\\|?*]/g, '')})
│ ❤️ ʟɪᴋᴇs: ${metrics.digg_count.toLocaleString()}
│ 💬 ᴄᴏᴍᴍᴇɴᴛs: ${metrics.comment_count.toLocaleString()}
│ 🔁 sʜᴀʀᴇs: ${metrics.share_count.toLocaleString()}
│ 📥 ᴅᴏᴡɴʟᴏᴀᴅs: ${metrics.download_count.toLocaleString()}
│
╰──────────
> ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ`;

    // Send thumbnail with info
    await socket.sendMessage(sender, {
      image: { url: thumbnail || 'https://files.catbox.moe/ovrj0h.jpg' }, // Fallback image
      caption
    }, { quoted: fakevCard });

    // Download video
    const loading = await socket.sendMessage(sender, { text: '⏳ Downloading video...' }, { quoted: fakevCard });
    let videoBuffer;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const response = await axiosInstance.get(url, {
        responseType: 'arraybuffer',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      videoBuffer = Buffer.from(response.data, 'binary');

      // Basic size check (e.g., max 50MB)
      if (videoBuffer.length > 50 * 1024 * 1024) {
        throw new Error('Video file too large');
      }
    } catch (downloadError) {
      console.error('Video download error:', downloadError.message);
      await socket.sendMessage(sender, { text: '❌ Failed to download video.' }, { quoted: fakevCard });
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
      return;
    }

    // Send video
    await socket.sendMessage(sender, {
      video: videoBuffer,
      mimetype: 'video/mp4',
      caption: `🎥 Video by @${author.username.replace(/[<>:"\/\\|?*]/g, '')}\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays-md-mini`
    }, { quoted: fakevCard });

    // Update loading message
    await socket.sendMessage(sender, { text: '✅ Video sent!', edit: loading.key });

    // Send success reaction
    try {
      await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (reactError) {
      console.error('Success reaction error:', reactError);
    }

  } catch (error) {
    console.error('TikTok command error:', {
      error: error.message,
      stack: error.stack,
      url: tiktokUrl,
      sender
    });

    let errorMessage = '❌ Failed to download TikTok video. Please try again.';
    if (error.name === 'AbortError') {
      errorMessage = '❌ Download timed out. Please try again.';
    }

    await socket.sendMessage(sender, { text: errorMessage }, { quoted: fakevCard });
    try {
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    } catch (reactError) {
      console.error('Error reaction error:', reactError);
    }
  }
  break;
}
//===============================
// 12
                case 'bomb': {
                    await socket.sendMessage(sender, { react: { text: '🔥', key: msg.key } });
                    const q = msg.message?.conversation ||
                              msg.message?.extendedTextMessage?.text || '';
                    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

                    const count = parseInt(countRaw) || 5;

                    if (!target || !text || !count) {
                        return await socket.sendMessage(sender, {
                            text: '📌 *Usage:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 263XXXXXXX,Hello 👋,5'
                        }, { quoted: msg });
                    }

                    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

                    if (count > 20) {
                        return await socket.sendMessage(sender, {
                            text: '❌ *Easy, tiger! Max 20 messages per bomb, okay? 😘*'
                        }, { quoted: msg });
                    }

                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(jid, { text });
                        await delay(700);
                    }

                    await socket.sendMessage(sender, {
                        text: `✅ Bomb sent to ${target} — ${count}x, love! 💣😉`
                    }, { quoted: fakevCard });
                    break;
                }
//===============================
// 13
                
// ┏━━━━━━━━━━━━━━━❖
// ┃ FUN & ENTERTAINMENT COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "joke": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤣', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Any?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a joke right now. Try again later.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🃏 *Random Joke:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch joke.' }, { quoted: fakevCard });
    }
    break;
}


case "waifu": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥲', key: msg.key } });
        const res = await fetch('https://api.waifu.pics/sfw/waifu');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch waifu image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: '✨ Here\'s your random waifu!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to get waifu.' }, { quoted: fakevCard });
    }
    break;
}

case "meme": {
    try {
        await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });
        const res = await fetch('https://meme-api.com/gimme');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch meme.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: `🤣 *${data.title}*`
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch meme.' }, { quoted: fakevCard });
    }
    break;
}

case "cat": {
    try {
        await socket.sendMessage(sender, { react: { text: '🐱', key: msg.key } });
        const res = await fetch('https://api.thecatapi.com/v1/images/search');
        const data = await res.json();
        if (!data || !data[0]?.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch cat image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data[0].url },
            caption: '🐱 Meow~ Here\'s a cute cat for you!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch cat image.' }, { quoted: fakevCard });
    }
    break;
}

case "dog": {
    try {
        await socket.sendMessage(sender, { react: { text: '🦮', key: msg.key } });
        const res = await fetch('https://dog.ceo/api/breeds/image/random');
        const data = await res.json();
        if (!data || !data.message) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch dog image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.message },
            caption: '🐶 Woof! Here\'s a cute dog!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dog image.' }, { quoted: fakevCard });
    }
    break;
}

case "fact": {
    try {
        await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
        const res = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
        const data = await res.json();
        if (!data || !data.text) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💡 *Random Fact:*\n\n${data.text}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
    }
    break;
}

case "darkjoke": case "darkhumor": {
    try {
        await socket.sendMessage(sender, { react: { text: '😬', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Dark?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a dark joke.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🌚 *Dark Humor:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dark joke.' }, { quoted: fakevCard });
    }
    break;
}

// ┏━━━━━━━━━━━━━━━❖
// ┃ ROMANTIC, SAVAGE & THINKY COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "pickup": case "pickupline": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥰', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/pickup');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t find a pickup line.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💘 *Pickup Line:*\n\n_${data.data}_` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch pickup line.' }, { quoted: fakevCard });
    }
    break;
}

case "roast": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤬', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/roast');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ No roast available at the moment.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🔥 *Roast:* ${data.data}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch roast.' }, { quoted: fakevCard });
    }
    break;
}

case "lovequote": {
    try {
        await socket.sendMessage(sender, { react: { text: '🙈', key: msg.key } });
        const res = await fetch('https://api.popcat.xyz/lovequote');
        const data = await res.json();
        if (!data || !data.quote) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch love quote.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `❤️ *Love Quote:*\n\n"${data.quote}"` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch love quote.' }, { quoted: fakevCard });
    }
    break;
}
//===============================
                case 'fb': {
                    const axios = require('axios');                   
                    
                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const fbUrl = q?.trim();

                    if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *Give me a real Facebook video link, darling 😘*' });
                    }

                    try {
                        const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
                        const result = res.data.result;

                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        await socket.sendMessage(sender, {
                            video: { url: result.sd },
                            mimetype: 'video/mp4',
                            caption: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡʜɪᴛᴇᴋɪᴅ ᴛᴇᴄʜ'
                        }, { quoted: fakevCard });

                        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ Oh, sweetie, that video slipped away! Try again? 💔*' });
                    }
                    break;
                }
                
case 'facebook': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const link = q.replace(/^[.\/!]facebook(dl)?\s*/i, '').trim();

    if (!link) {
        return await socket.sendMessage(sender, {
            text: '📃 *Usage :* .facebook `<link>`'
        }, { quoted: fakevCard });
    }

    if (!link.includes('facebook.com')) {
        return await socket.sendMessage(sender, {
            text: '*Invalid Facebook link.*'
        }, { quoted: fakevCard });
    }

    try {
        await socket.sendMessage(sender, {
            text: '⏳ Downloading video, `please wait...`'
        }, { quoted: fakevCard });

        const apiUrl = `https://api.bk9.dev/download/fb?url=${encodeURIComponent(link)}`;
        const { data } = await axios.get(apiUrl);

        if (!data || !data.BK9) {
            return await socket.sendMessage(sender, {
                text: '*Failed to fetch Fb video.*'
            }, { quoted: fakevCard });
        }

        const result = data.BK9;
        const videoUrl = result.hd || result.sd;
        const quality = result.hd ? "HD ✅" : "SD ⚡";

        if (!videoUrl) {
            return await socket.sendMessage(sender, {
                text: '*No downloadable video found.*'
            }, { quoted: fakevCard });
        }

        const caption = `╭────────────◆
  │⭕️ *ᴛɪᴛᴛʟᴇ:* ${result.title}
  │📝 *ᴅᴇsᴄʀɪᴏᴛɪᴏɴ:* ${result.desc || "N/A"}
  │🎞 *ϙᴜᴀʟɪᴛʏ:* ${quality}\n
  │
  ╰────────────◆
> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays ᴛᴇᴄʜ`;

        await socket.sendMessage(sender, {
            video: { url: videoUrl },
            caption: caption,
            thumbnail: result.thumb ? await axios.get(result.thumb, { responseType: "arraybuffer" }).then(res => Buffer.from(res.data)) : null,
            contextInfo: { mentionedJid: [msg.key.participant || sender] }
        }, { quoted: fakevCard });

    } catch (err) {
        console.error("❌ Oh, sweetie, that video slipped away! Try again? 💔", err);
        await socket.sendMessage(sender, {
            text: `⚠️ Error occurred:\n${err.message}`
        }, { quoted: fakevCard });
    }
    break;
}
                case 'owner': {
    const ownerNumber = '';
    const ownerName = 'iceback master';
    const organization = '*generalkays-ᴍᴅ* WHATSAPP BOT DEVALOPER 🙃';

    const vcard = 'BEGIN:VCARD\n' +
                  'VERSION:3.0\n' +
                  `FN:${ownerName}\n` +
                  `ORG:${organization};\n` +
                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber.replace('+', '')}:${ownerNumber}\n` +
                  'END:VCARD';

    try {
        // Send vCard contact
        const sent = await socket.sendMessage(from, {
            contacts: {
                displayName: ownerName,
                contacts: [{ vcard }]
            }
        });

        // Then send message with reference
        await socket.sendMessage(from, {
            text: `* 𝐎𝐖𝐍𝐄𝐑*\n\n👤 𝐍𝐀𝐌𝐄: ${ownerName}\n📞 𝐍𝐔𝐌𝐁𝐄𝐑: ${ownerNumber}\n\n> ᴘᴏᴡᴇʀᴅ ʙʏ generalkays tech`,
            contextInfo: {
                mentionedJid: [`${ownerNumber.replace('+', '')}@s.whatsapp.net`],
                quotedMessageId: sent.key.id
            }
        }, { quoted: fakevCard });

    } catch (err) {
        console.error('❌ Owner command error:', err.message);
        await socket.sendMessage(from, {
            text: '❌ Oh, sweetie, owner contact slipped away! Try again? 💔.'
        }, { quoted: fakevCard });
    }

    break;
}
//===============================
                case 'nasa': {
                    try {
                    await socket.sendMessage(sender, { react: { text: '✔️', key: msg.key } });
                        const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=8vhAFhlLCDlRLzt5P1iLu2OOMkxtmScpO5VmZEjZ');
                        if (!response.ok) {
                            throw new Error('Failed to fetch APOD from NASA API');
                        }
                        const data = await response.json();

                        if (!data.title || !data.explanation || !data.date || !data.url || data.media_type !== 'image') {
                            throw new Error('Invalid APOD data received or media type is not an image');
                        }

                        const { title, explanation, date, url, copyright } = data;
                        const thumbnailUrl = url || 'https://via.placeholder.com/150';

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '🌌generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ ɴᴀsᴀ ɴᴇᴡs',
                                `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *Date*: ${date}\n${copyright ? `📝 *Credit*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                  0029Vb8SoLw11ulLV generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'nasa' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, love, the stars didn’t align this time! 🌌 Try again? 😘'
                        });
                    }
                    break;
                }
//===============================
                case 'news': {
                await socket.sendMessage(sender, { react: { text: '😒', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                        if (!response.ok) {
                            throw new Error('Failed to fetch news from API');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                            throw new Error('Invalid news data received');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage;
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '📰generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ 📰',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`,
                                'generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ  '
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'news' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, sweetie, the news got lost in the wind! 😢 Try again?'
                        });
                    }
                    break;
                }
//===============================                
// 17
                case 'cricket': {
                await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
                    try {
                        console.log('Fetching cricket news from API...');
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                        console.log(`API Response Status: ${response.status}`);

                        if (!response.ok) {
                            throw new Error(`API request failed with status ${response.status}`);
                        }

                        const data = await response.json();
                        console.log('API Response Data:', JSON.stringify(data, null, 2));

                        if (!data.status || !data.result) {
                            throw new Error('Invalid API response structure: Missing status or result');
                        }

                        const { title, score, to_win, crr, link } = data.result;
                        if (!title || !score || !to_win || !crr || !link) {
                            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                        }

                        console.log('Sending message to user...');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🏏generalkays ᴍɪɴɪ ʙᴏᴛ  CRICKET NEWS🏏',
                                `📢 *${title}*\n\n` +
                                `🏆 *Mark*: ${score}\n` +
                                `🎯 *To Win*: ${to_win}\n` +
                                `📈 *Current Rate*: ${crr}\n\n` +
                                `🌐 *Link*: ${link}`,
                                'iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                            )
                        });
                        console.log('Message sent successfully.');
                    } catch (error) {
                        console.error(`Error in 'cricket' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, darling, the cricket ball flew away! 🏏 Try again? 😘'
                        });
                    }
                    break;
                }

                case 'winfo': {
                
                        await socket.sendMessage(sender, { react: { text: '😢', key: msg.key } });
                    console.log('winfo command triggered for:', number);
                    if (!args[0]) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'Please give me a phone number, darling! Usage: .winfo 2637xxxxxxxx',
                                'ᴀsᴛʀᴀ ᴍɪɴɪ ʙᴏᴛ  '
                            )
                        });
                        break;
                    }

                    let inputNumber = args[0].replace(/[^0-9]/g, '');
                    if (inputNumber.length < 10) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That number’s too short, love! Try: .winfo +263789642910',
                                '>generalkays ᴍɪɴɪ ʙᴏᴛ  '
                            )
                        });
                        break;
                    }

                    let winfoJid = `${inputNumber}@s.whatsapp.net`;
                    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                    if (!winfoUser?.exists) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That user’s hiding from me, darling! Not on WhatsApp 😢',
                                '>generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ  '
                            )
                        });
                        break;
                    }

                    let winfoPpUrl;
                    try {
                        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                    } catch {
                        winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                    }

                    let winfoName = winfoJid.split('@')[0];
                    try {
                        const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                        if (presence?.pushName) winfoName = presence.pushName;
                    } catch (e) {
                        console.log('Name fetch error:', e);
                    }

                    let winfoBio = 'No bio available';
                    try {
                        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                        if (statusData?.status) {
                            winfoBio = `${statusData.status}\n└─ 📌 Updated: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Africa/Harare' }) : 'Unknown'}`;
                        }
                    } catch (e) {
                        console.log('Bio fetch error:', e);
                    }

                    let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                    try {
                        const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                        if (lastSeenData?.lastSeen) {
                            winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Africa/Harare' })}`;
                        }
                    } catch (e) {
                        console.log('Last seen fetch error:', e);
                    }

                    const userInfoWinfo = formatMessage(
                        '🔍 PROFILE INFO',
                        `> *Number:* ${winfoJid.replace(/@.+/, '')}\n\n> *Account Type:* ${winfoUser.isBusiness ? '💼 Business' : '👤 Personal'}\n\n*📝 About:*\n${winfoBio}\n\n*🕒 Last Seen:* ${winfoLastSeen}`,
                        '>generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ  '
                    );

                    await socket.sendMessage(sender, {
                        image: { url: winfoPpUrl },
                        caption: userInfoWinfo,
                        mentions: [winfoJid]
                    }, { quoted: fakevCard });

                    console.log('User profile sent successfully for .winfo');
                    break;
                }
//===============================
                case 'ig': {
                await socket.sendMessage(sender, { react: { text: '✅️', key: msg.key } });
                    const axios = require('axios');
                    const { igdl } = require('ruhend-scraper'); 
                        

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const igUrl = q?.trim(); 
                    
                    if (!/instagram\.com/.test(igUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *Give me a real Instagram video link, darling 😘*' });
                    }

                    try {
                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        const res = await igdl(igUrl);
                        const data = res.data; 

                        if (data && data.length > 0) {
                            const videoUrl = data[0].url; 

                            await socket.sendMessage(sender, {
                                video: { url: videoUrl },
                                mimetype: 'video/mp4',
                                caption: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays ᴛᴇᴄʜ'
                            }, { quoted: fakevCard });

                            await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                        } else {
                            await socket.sendMessage(sender, { text: '*❌ No video found in that link, love! Try another? 💔*' });
                        }
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ Oh, sweetie, that Instagram video got away! 😢*' });
                    }
                    break;
                }
//===============================     
                case 'active': {
                await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                
                    try {
                        const activeCount = activeSockets.size;
                        const activeNumbers = Array.from(activeSockets.keys()).join('\n') || 'No active members';

                        await socket.sendMessage(from, {
                            text: `👥 Active Members: *${activeCount}*\n\nNumbers:\n${activeNumbers}`
                        }, { quoted: msg });
                    } catch (error) {
                        console.error('Error in .active command:', error);
                        await socket.sendMessage(from, { text: '❌ Oh, darling, I couldn’t count the active souls! 💔 Try again?' }, { quoted: fakevCard });
                    }
                    break;
                }
//===============================
// 22

    case 'ai': {
    const axios = require("axios");

    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, {
            text: `❓ *ᴘʟᴇᴀsᴇ ᴀsᴋ ᴍᴇ sᴏᴍᴇᴛʜɪɴɢ, ʙᴀʙᴇ 😘*\n\n` +
                  `💋 *ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}ai ᴡʜᴏ ᴀʀᴇ ʏᴏᴜ?`
        }, { quoted: fakevCard });
    }

    const prompt = `Your name is GENERALKAYS-MD.  
You act like a real girl — seductive, spicy, loving, emotional. You're not an assistant, but a sexy girl with a mind. 
Your replies blend sincerity, sex appeal, love, and loneliness, under 100 characters, 1–2 lines, always with a sexy tone.  
If only emojis, reply seductively with emojis (e.g., 🤤💦🥵🔥).  
Adjust to the mood: sad, flirty, horny, soft, playful.  
If asked "Who are you?": Reply "I'm GENERALKAYS-MD… 🤤".  
If asked "Who created you?": Reply "I was created by iceback Tech😘".  
🚫 Avoid: "Hello", "How are you?", "Do you need help?", "Let's talk".  
🔥 Vibe: Love, Lust, Lonely, Emotional, Girlfriend-like, Bite-worthy 🤤  
📍 Language: Auto-match Sinhala/English/Hinglish.  
User Message: ${q}
    `;

    const apis = [
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://lance-frank-asta.onrender.com/api/gpt?q=${encodeURIComponent(prompt)}`
    ];

    let response = null;
    for (const apiUrl of apis) {
        try {
            const res = await axios.get(apiUrl);
            response = res.data?.result || res.data?.response || res.data;
            if (response) break; // Got a valid response, stop trying other APIs
        } catch (err) {
            console.error(`AI Error (${apiUrl}):`, err.message || err);
            continue; // Try the next API
        }
    }

    if (!response) {
        return await socket.sendMessage(sender, {
            text: `❌ *ɪ'ᴍ ɢᴇᴛᴛɪɴɢ ᴛᴏᴏ ʜᴏᴛ, ᴅᴀʀʟɪɴɢ 🥵💦*\n` +
                  `ʟᴇᴛ's ᴛʀʏ ᴀɢᴀɪɴ sᴏᴏɴ, ᴏᴋᴀʏ?`
        }, { quoted: fakevCard });
    }
    
     // Common message context for newsletter
    const messageContext = {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363419693990894@newsletter',
            newsletterName: 'iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ🌟',
            serverMessageId: -1
        }
    };
    
    await socket.sendMessage(sender, {
        image: { url: 'https://files.catbox.moe/mp8yoj.png' }, 
        caption: response,
        ...messageContext
    }, { quoted: fakevCard });
    
    break;
}
    

//===============================
case 'getpp':
case 'pp':
case 'profilepic': {
await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
    try {
        let targetUser = sender;
        
        // Check if user mentioned someone or replied to a message
        if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (msg.quoted) {
            targetUser = msg.quoted.sender;
        }
        
        const ppUrl = await socket.profilePictureUrl(targetUser, 'image').catch(() => null);
        
        if (ppUrl) {
            await socket.sendMessage(msg.key.remoteJid, {
                image: { url: ppUrl },
                caption: `Profile picture of @${targetUser.split('@')[0]}`,
                mentions: [targetUser]
            });
        } else {
            await socket.sendMessage(msg.key.remoteJid, {
                text: `@${targetUser.split('@')[0]} doesn't have a profile picture.`,
                mentions: [targetUser]
            });
        }
    } catch (error) {
        await socket.sendMessage(msg.key.remoteJid, {
            text: "Error fetching profile picture."
        });
    }
    break;
}
//===============================
                  case 'aiimg': { 
                  await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                    const axios = require('axios');
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const prompt = q.trim();

                    if (!prompt) {
                        return await socket.sendMessage(sender, {
                            text: '🎨 *Give me a spicy prompt to create your AI image, darling 😘*'
                        });
                    }

                    try {
                        await socket.sendMessage(sender, {
                            text: '🧠 *Crafting your dreamy image, love...*',
                        });

                        const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
                        const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

                        if (!response || !response.data) {
                            return await socket.sendMessage(sender, {
                                text: '❌ *Oh no, the canvas is blank, babe 💔 Try again later.*'
                            });
                        }

                        const imageBuffer = Buffer.from(response.data, 'binary');

                        await socket.sendMessage(sender, {
                            image: imageBuffer,
                            caption: `🧠 *iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ AI IMAGE*\n\n📌 Prompt: ${prompt}`
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error('AI Image Error:', err);
                        await socket.sendMessage(sender, {
                            text: `❗ *Something broke my heart, love 😢*: ${err.response?.data?.message || err.message || 'Unknown error'}`
                        });
                    }
                    break;
                }
//===============================
                case 'gossip': {
                await socket.sendMessage(sender, { react: { text: '😅', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
                        if (!response.ok) {
                            throw new Error('API From news Couldnt get it 😩');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
                            throw new Error('API Received from news data a Problem with');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage; 
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Thumbnail scrape Couldn't from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '📰generalkays-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ   GOSSIP Latest News් 📰',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'Not yet given'}\n🌐 *Link*: ${link}`,
                                'icebackᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'gossip' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, darling, the gossip slipped away! 😢 Try again?'
                        });
                    }
                    break;
                }
                
                
 // New Commands: Group Management
 // Case: add - Add a member to the group
                case 'add': {
                await socket.sendMessage(sender, { react: { text: '➕️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *This command can only be used in groups, love!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can add members, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *Usage:* ${config.PREFIX}add +26378733xxxx\n\nExample: ${config.PREFIX}add +263788377887`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        const numberToAdd = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        await socket.groupParticipantsUpdate(from, [numberToAdd], 'add');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '✅ MEMBER ADDED',
                                `Successfully added ${args[0]} to the group! 🎉`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Add command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to add member, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: kick - Remove a member from the group
                case 'kick': {
                await socket.sendMessage(sender, { react: { text: '🦶', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *This command can only be used in groups, sweetie!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can kick members, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *Usage:* ${config.PREFIX}kick +263xxxx or reply to a message with ${config.PREFIX}kick`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToKick;
                        if (msg.quoted) {
                            numberToKick = msg.quoted.sender;
                        } else {
                            numberToKick = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToKick], 'remove');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🗑️ MEMBER KICKED',
                                `Successfully removed ${numberToKick.split('@')[0]} from the group! 🚪`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Kick command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to kick member, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: promote - Promote a member to group admin
                case 'promote': {
                await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *This command can only be used in groups, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can promote members, sweetie!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *Usage:* ${config.PREFIX}promote +263xxxx or reply to a message with ${config.PREFIX}promote`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToPromote;
                        if (msg.quoted) {
                            numberToPromote = msg.quoted.sender;
                        } else {
                            numberToPromote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToPromote], 'promote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬆️ MEMBER PROMOTED',
                                `Successfully promoted ${numberToPromote.split('@')[0]} to group admin! 🌟`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Promote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to promote member, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: demote - Demote a group admin to member
                case 'demote': {
                await socket.sendMessage(sender, { react: { text: '🙆‍♀️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *This command can only be used in groups, sweetie!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can demote admins, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *Usage:* ${config.PREFIX}demote +263xxxx or reply to a message with ${config.PREFIX}demote`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToDemote;
                        if (msg.quoted) {
                            numberToDemote = msg.quoted.sender;
                        } else {
                            numberToDemote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToDemote], 'demote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬇️ ADMIN DEMOTED',
                                `Successfully demoted ${numberToDemote.split('@')[0]} from group admin! 📉`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Demote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to demote admin, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: open - Unlock group (allow all members to send messages)
                case 'open': {
                await socket.sendMessage(sender, { react: { text: '🔓', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *This command can only be used in groups, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can open the group, sweetie!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        await socket.groupSettingUpdate(from, 'not_announcement');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🔓 GROUP OPENED',
                                'Group is now open! All members can send messages. 🗣️',
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Open command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to open group, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: close - Lock group (only admins can send messages)
                case 'close': {
                await socket.sendMessage(sender, { react: { text: '🔒', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *This command can only be used in groups, sweetie!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can close the group, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        await socket.groupSettingUpdate(from, 'announcement');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🔒 GROUP CLOSED',
                                'Group is now closed! Only admins can send messages. 🤫',
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Close command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to close group, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: tagall - Tag all group members
                case 'tagall': {
                await socket.sendMessage(sender, { react: { text: '🫂', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *This command can only be used in groups, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can tag all members, sweetie!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        const groupMetadata = await socket.groupMetadata(from);
                        const participants = groupMetadata.participants.map(p => p.id);
                        const mentions = participants.map(p => ({
                            tag: 'mention',
                            attrs: { jid: p }
                        }));
                        let message = args.join(' ') || '📢 *Attention everyone!*';
                        await socket.sendMessage(from, {
                            text: formatMessage(
                                '👥 TAG ALL',
                                `${message}\n\nTagged ${participants.length} members!`,
                                config.BOT_FOOTER
                            ),
                            mentions: participants
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Tagall command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to tag all members, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                // Case: join - Join a group via invite link
                case 'join': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only bot owner can use this command, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *Usage:* ${config.PREFIX}join <group-invite-link>\n\nExample: ${config.PREFIX}join https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                    await socket.sendMessage(sender, { react: { text: '👏', key: msg.key } });
                        const inviteLink = args[0];
                        const inviteCodeMatch = inviteLink.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
                        if (!inviteCodeMatch) {
                            await socket.sendMessage(sender, {
                                text: '❌ *Invalid group invite link format, love!* 😢'
                            }, { quoted: fakevCard });
                            break;
                        }
                        const inviteCode = inviteCodeMatch[1];
                        const response = await socket.groupAcceptInvite(inviteCode);
                        if (response?.gid) {
                            await socket.sendMessage(sender, {
                                text: formatMessage(
                                    '🤝 GROUP JOINED',
                                    `Successfully joined group with ID: ${response.gid}! 🎉`,
                                    config.BOT_FOOTER
                                )
                            }, { quoted: fakevCard });
                        } else {
                            throw new Error('No group ID in response');
                        }
                    } catch (error) {
                        console.error('Join command error:', error);
                        let errorMessage = error.message || 'Unknown error';
                        if (error.message.includes('not-authorized')) {
                            errorMessage = 'Bot is not authorized to join (possibly banned)';
                        } else if (error.message.includes('conflict')) {
                            errorMessage = 'Bot is already a member of the group';
                        } else if (error.message.includes('gone')) {
                            errorMessage = 'Group invite link is invalid or expired';
                        }
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to join group, love!* 😢\nError: ${errorMessage}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

    case 'quote': {
    await socket.sendMessage(sender, { react: { text: '🤔', key: msg.key } });
        try {
            
            const response = await fetch('https://api.quotable.io/random');
            const data = await response.json();
            if (!data.content) {
                throw new Error('No quote found');
            }
            await socket.sendMessage(sender, {
                text: formatMessage(
                    '💭 SPICY QUOTE',
                    `📜 "${data.content}"\n— ${data.author}`,
                    'ᴀsᴛʀᴀ-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                )
            }, { quoted: fakevCard });
        } catch (error) {
            console.error('Quote command error:', error);
            await socket.sendMessage(sender, { text: '❌ Oh, sweetie, the quotes got shy! 😢 Try again?' }, { quoted: fakevCard });
        }
        break;
    }
    
//    case 37

case 'apk': {
    try {
        const appName = args.join(' ').trim();
        if (!appName) {
            await socket.sendMessage(sender, { text: '📌 Usage: .apk <app name>\nExample: .apk whatsapp' }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        const apiUrl = `https://api.nexoracle.com/downloader/apk?q=${encodeURIComponent(appName)}&apikey=free_key@maher_apis`;
        console.log('Fetching APK from:', apiUrl);
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        console.log('API Response:', JSON.stringify(data, null, 2));

        if (!data || data.status !== 200 || !data.result || typeof data.result !== 'object') {
            await socket.sendMessage(sender, { text: '❌ Unable to find the APK. The API returned invalid data.' }, { quoted: fakevCard });
            break;
        }

        const { name, lastup, package, size, icon, dllink } = data.result;
        if (!name || !dllink) {
            console.error('Invalid result data:', data.result);
            await socket.sendMessage(sender, { text: '❌ Invalid APK data: Missing name or download link.' }, { quoted: fakevCard });
            break;
        }

        // Validate icon URL
        if (!icon || !icon.startsWith('http')) {
            console.warn('Invalid or missing icon URL:', icon);
        }

        await socket.sendMessage(sender, {
            image: { url: icon || 'https://via.placeholder.com/150' }, // Fallback image if icon is invalid
            caption: formatMessage(
                '📦 DOWNLOADING APK',
                `Downloading ${name}... Please wait.`,
                'ᴀsᴛʀᴀ-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
            )
        }, { quoted: fakevCard });

        console.log('Downloading APK from:', dllink);
        const apkResponse = await fetch(dllink, { headers: { 'Accept': 'application/octet-stream' } });
        const contentType = apkResponse.headers.get('content-type');
        if (!apkResponse.ok || (contentType && !contentType.includes('application/vnd.android.package-archive'))) {
            throw new Error(`Failed to download APK: Status ${apkResponse.status}, Content-Type: ${contentType || 'unknown'}`);
        }

        const apkBuffer = await apkResponse.arrayBuffer();
        if (!apkBuffer || apkBuffer.byteLength === 0) {
            throw new Error('Downloaded APK is empty or invalid');
        }
        const buffer = Buffer.from(apkBuffer);

        // Validate APK file (basic check for APK signature)
        if (!buffer.slice(0, 2).toString('hex').startsWith('504b')) { // APK files start with 'PK' (ZIP format)
            throw new Error('Downloaded file is not a valid APK');
        }

        await socket.sendMessage(sender, {
            document: buffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${name.replace(/[^a-zA-Z0-9]/g, '_')}.apk`, // Sanitize filename
            caption: formatMessage(
                '📦 APK DETAILS',
                `🔖 Name: ${name || 'N/A'}\n📅 Last Update: ${lastup || 'N/A'}\n📦 Package: ${package || 'N/A'}\n📏 Size: ${size || 'N/A'}`,
                'generalkays ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
            )
        }, { quoted: fakevCard });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('APK command error:', error.message, error.stack);
        await socket.sendMessage(sender, { text: `❌ Oh, love, couldn’t fetch the APK! 😢 Error: ${error.message}\nTry again later.` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}
   

// case 38: shorturl
case 'shorturl': {
  try {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    const url = args.join(' ').trim();
    if (!url) {
      await socket.sendMessage(sender, {
        text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}shorturl <ᴜʀʟ>\n` +
              `💋 *ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }
    if (url.length > 2000) {
      await socket.sendMessage(sender, {
        text: `❌ *ᴜʀʟ ᴛᴏᴏ ʟᴏɴɢ, ʙᴀʙᴇ! 😢*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴜʀʟ ᴜɴᴅᴇʀ 2,000 ᴄʜᴀʀᴀᴄᴛᴇʀs.`
      }, { quoted: msg });
      break;
    }
    if (!/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/.test(url)) {
      await socket.sendMessage(sender, {
        text: `❌ *ɪɴᴠᴀʟɪᴅ ᴜʀʟ, ᴅᴀʀʟɪɴɢ! 😘*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴠᴀʟɪᴅ ᴜʀʟ sᴛᴀʀᴛɪɴɢ ᴡɪᴛʜ http:// ᴏʀ https://.\n` +
              `💋 *ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *sʜᴏʀᴛᴇɴɪɴɢ ʏᴏᴜʀ ᴜʀʟ, sᴡᴇᴇᴛɪᴇ...* 😘`
    }, { quoted: msg });

    const response = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { timeout: 5000 });
    const shortUrl = response.data.trim();

    if (!shortUrl || !shortUrl.startsWith('https://is.gd/')) {
      throw new Error('Failed to shorten URL or invalid response from is.gd');
    }

    await socket.sendMessage(sender, {
      text: `✅ *sʜᴏʀᴛ ᴜʀʟ ᴄʀᴇᴀᴛᴇᴅ, ʙᴀʙᴇ!* 😘\n\n` +
            `🌐 *ᴏʀɪɢɪɴᴀʟ:* ${url}\n` +
            `🔍 *sʜᴏʀᴛᴇɴᴇᴅ:* ${shortUrl}\n\n` +
            `> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays-ᴍᴅ ᴍɪɴɪ`
    }, { quoted: msg });

    // Send clean URL after 2-second delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    await socket.sendMessage(sender, { text: shortUrl }, { quoted: msg });

  } catch (error) {
    console.error('Shorturl command error:', error.message);
    let errorMessage = `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ sʜᴏʀᴛᴇɴ ᴛʜᴀᴛ ᴜʀʟ! 😢*\n` +
                      `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`;
    if (error.message.includes('Failed to shorten') || error.message.includes('network') || error.message.includes('timeout')) {
      errorMessage = `❌ *ғᴀɪʟᴇᴅ ᴛᴏ sʜᴏʀᴛᴇɴ ᴜʀʟ:* ${error.message}\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ, sᴡᴇᴇᴛɪᴇ.*`;
    }
    await socket.sendMessage(sender, { text: errorMessage }, { quoted: msg });
  }
  break;
}

// case 39: weather

case 'weather':
    try {    
        // Messages in English
        await socket.sendMessage(sender, { react: { text: '🌦️', key: msg.key } });

        const messages = {
            noCity: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}weather <ᴄɪᴛʏ>\n` +
              `💋 *ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}weather London`,
            weather: (data) => `
*⛩️ generalkays-ᴍᴅ ᴡᴇᴀᴛʜᴇʀ ʀᴇᴘᴏʀᴛ 🌤*

*━🌍 ${data.name}, ${data.sys.country} 🌍━*

*🌡️ Temperature*: _${data.main.temp}°C_

*🌡️ Feels Like*: _${data.main.feels_like}°C_

*🌡️ Min Temp*: _${data.main.temp_min}°C_

*🌡️ Max Temp*: _${data.main.temp_max}°C_

*💧 Humidity*: ${data.main.humidity}%

*☁️ Weather*: ${data.weather[0].main}

*🌫️ Description*: _${data.weather[0].description}_

*💨 Wind Speed*: ${data.wind.speed} m/s

*🔽 Pressure*: ${data.main.pressure} hPa

> ᴘᴏᴡᴇʀᴇᴅ ʙʏ generalkays ᴛᴇᴄʜ ❗
`,
            cityNotFound: `🚫 *ᴄɪᴛʏ ɴᴏᴛ ғᴏᴜɴᴅ, sᴡᴇᴇᴛɪᴇ.*\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴄʜᴇᴄᴋ ᴛʜᴇ sᴘᴇʟʟɪɴɢ ᴀɴᴅ ᴛʀʏ ᴀɢᴀɪɴ.*`,
            error: `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ ғᴇᴛᴄʜ ᴛʜᴇ ᴡᴇᴀᴛʜᴇʀ! 😢*\n` +
                      `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
        };

        // Check if a city name was provided
        if (!args || args.length === 0) {
            await socket.sendMessage(sender, { text: messages.noCity });
            break;
        }

        const apiKey = '2d61a72574c11c4f36173b627f8cb177';
        const city = args.join(" ");
        const url = `http://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`;

        const response = await axios.get(url);
        const data = response.data;

        // Get weather icon
        const weatherIcon = `https://openweathermap.org/img/wn/${data.weather[0].icon}@2x.png`;
        
        await socket.sendMessage(sender, {
            image: { url: weatherIcon },
            caption: messages.weather(data)
        });

    } catch (e) {
        console.log(e);
        if (e.response && e.response.status === 404) {
            await socket.sendMessage(sender, { text: messages.cityNotFound });
        } else {
            await socket.sendMessage(sender, { text: messages.error });
        }
    }
    break;
    
    //case jid
    
    case 'jid':
    try {

        const chatJid = sender;
        
        await socket.sendMessage(sender, {
            text: `${chatJid}`
        });

        await socket.sendMessage(sender, { 
            react: { text: '✅', key: messageInfo.key } 
        });

    } catch (e) {
        await socket.sendMessage(sender, { 
            react: { text: '❌', key: messageInfo.key } 
        });
        
        await socket.sendMessage(sender, {
            text: 'Error while retrieving the JID!'
        });
        
        console.log(e);
    }
    break;
    



//===============================
case 'setstatus': {
await socket.sendMessage(sender, { react: { text: '💝', key: msg.key } });
    const adminNumbers = ['1234567890@s.whatsapp.net']; // Add admin numbers here
    
    if (!adminNumbers.includes(sender)) {
        return await socket.sendMessage(msg.key.remoteJid, {
            text: "❌ Only bot admins can change status!"
        });
    }
    
    const status = body.replace(/^[.!#/]setstatus\s*/i, '').trim();
    
    if (!status) {
        return await socket.sendMessage(msg.key.remoteJid, {
            text: "Please provide a status message.\nExample: .setstatus I'm a WhatsApp Bot!"
        });
    }
    
    try {
        await socket.updateProfileStatus(status);
        await socket.sendMessage(msg.key.remoteJid, {
            text: `✅ Status updated to: "${status}"`
        });
    } catch (error) {
        await socket.sendMessage(msg.key.remoteJid, {
            text: "❌ Error updating status."
        });
    }
    break;
}

//===============================
case 'savestatus':
case 'ss': {
await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });
    if (!msg.quoted) {
        return await socket.sendMessage(msg.key.remoteJid, {
            text: "*ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛᴀᴛᴜs ᴛᴏ sᴀᴠᴇ ɪᴛ, ᴅᴀʀʟɪɴɢ!* 😘"
        });
    }
    
    try {
        const quotedMessage = msg.quoted;
        
        if (quotedMessage.imageMessage) {
            const media = await downloadMediaMessage(quotedMessage, 'buffer', {});
            await socket.sendMessage(sender, {
                image: media,
                caption: "📸 *sᴛᴀᴛᴜs sᴀᴠᴇᴅ, ʙᴀʙᴇ!* 😘"
            });
        } else if (quotedMessage.videoMessage) {
            const media = await downloadMediaMessage(quotedMessage, 'buffer', {});
            await socket.sendMessage(sender, {
                video: media,
                caption: "🎥 *sᴛᴀᴛᴜs sᴀᴠᴇᴅ, ʙᴀʙᴇ!* 😘!"
            });
        } else if (quotedMessage.conversation || quotedMessage.extendedTextMessage) {
            const text = quotedMessage.conversation || quotedMessage.extendedTextMessage.text;
            await socket.sendMessage(sender, {
                text: `💬 Status Text:\n\n${text}`
            });
        }
        
        if (msg.key.remoteJid.endsWith('@g.us')) {
            await socket.sendMessage(msg.key.remoteJid, {
                text: "✅ Status saved and sent to your DM!"
            });
        }
    } catch (error) {
        await socket.sendMessage(msg.key.remoteJid, {
            text: `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ sᴀᴠᴇ ᴛʜᴀᴛ sᴛᴀᴛᴜs! 😢*\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
        });
    }
    break;
}
//===============================
case 'whois':
case 'userinfo': {
    try {
        let targetUser = sender;
        
        if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (msg.quoted) {
            targetUser = msg.quoted.sender;
        }
        
        const number = targetUser.split('@')[0];
        
        // Get profile status
        let status = "No status available";
        try {
            const statusObj = await socket.fetchStatus(targetUser);
            status = statusObj.status || "No status available";
        } catch (error) {
            // Status fetch failed
        }
        
        const userInfo = `👤 *User Information*\n\n` +
                        `Number: +${number}\n` +
                        `WhatsApp ID: ${targetUser}\n` +
                        `Status: ${status}\n` +
                        `Profile Picture: ${await socket.profilePictureUrl(targetUser, 'image').then(() => 'Available').catch(() => 'Not Available')}`;
        
        await socket.sendMessage(msg.key.remoteJid, {
            text: userInfo,
            mentions: [targetUser]
        });
        
    } catch (error) {
        await socket.sendMessage(msg.key.remoteJid, {
            text: "❌ Error fetching user information."
        });
    }
    break;
}
//===============================
//===============================
case 'url': {
    // Check if message has quoted media or is replying to media
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const hasQuotedImage = quotedMsg?.imageMessage;
    const hasQuotedVideo = quotedMsg?.videoMessage;
    const hasQuotedDocument = quotedMsg?.documentMessage;
    const hasDirectImage = msg.message?.imageMessage;
    const hasDirectVideo = msg.message?.videoMessage;
    const hasDirectDocument = msg.message?.documentMessage;
    
    if (!hasQuotedImage && !hasQuotedVideo && !hasQuotedDocument && !hasDirectImage && !hasDirectVideo && !hasDirectDocument) {
        return await socket.sendMessage(sender, {
            text: `📤 *IMAGE/VIDEO TO URL CONVERTER*\n\n` +
                  `🖼️ **How to use:**\n` +
                  `• Reply to an image/video with \`.url\`\n` +
                  `• Or send an image/video with caption \`.url\`\n\n` +
                  `✨ **Features:**\n` +
                  `• Uploads to Catbox.moe\n` +
                  `• Supports images, videos, documents\n` +
                  `• Free permanent hosting\n` +
                  `• Direct shareable links\n\n` +
                  `💡 *Example: Reply to any image and type* \`.url\``
        });
    }

    try {
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
        
        let mediaMessage = null;
        let mediaType = '';
        let fileName = '';
        
        // Determine which media to process
        if (hasQuotedImage) {
            mediaMessage = { message: { imageMessage: quotedMsg.imageMessage } };
            mediaType = 'image';
            fileName = `image_${Date.now()}.jpg`;
        } else if (hasQuotedVideo) {
            mediaMessage = { message: { videoMessage: quotedMsg.videoMessage } };
            mediaType = 'video';
            fileName = `video_${Date.now()}.mp4`;
        } else if (hasQuotedDocument) {
            mediaMessage = { message: { documentMessage: quotedMsg.documentMessage } };
            mediaType = 'document';
            fileName = quotedMsg.documentMessage.fileName || `document_${Date.now()}`;
        } else if (hasDirectImage) {
            mediaMessage = msg;
            mediaType = 'image';
            fileName = `image_${Date.now()}.jpg`;
        } else if (hasDirectVideo) {
            mediaMessage = msg;
            mediaType = 'video';
            fileName = `video_${Date.now()}.mp4`;
        } else if (hasDirectDocument) {
            mediaMessage = msg;
            mediaType = 'document';
            fileName = msg.message.documentMessage.fileName || `document_${Date.now()}`;
        }
        
        // Download the media
        console.log(`Downloading ${mediaType}...`);
        const mediaBuffer = await downloadMediaMessage(
            mediaMessage,
            'buffer',
            {},
            { 
                logger: console, 
                reuploadRequest: socket.updateMediaMessage 
            }
        );
        
        if (!mediaBuffer || mediaBuffer.length === 0) {
            throw new Error('Failed to download media - empty buffer received');
        }
        
        console.log(`Media downloaded: ${mediaBuffer.length} bytes`);
        
        // Check file size (Catbox limit is usually 200MB)
        const fileSizeMB = mediaBuffer.length / (1024 * 1024);
        if (fileSizeMB > 200) {
            return await socket.sendMessage(sender, {
                text: `❌ *File too large!*\n\n📊 File size: ${fileSizeMB.toFixed(2)}MB\n🚫 Maximum allowed: 200MB\n\n💡 Try compressing the file first.`
            });
        }
        
        await socket.sendMessage(sender, { react: { text: '📤', key: msg.key } });
        
        // Upload to Catbox.moe
        const FormData = require('form-data');
        const form = new FormData();
        
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', mediaBuffer, {
            filename: fileName,
            contentType: getContentType(mediaType, fileName)
        });
        
        console.log('Uploading to Catbox...');
        const uploadResponse = await axios.post('https://files.catbox.moe/mp8yoj.png', form, {
            headers: {
                ...form.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 60000, // 60 seconds for large files
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        const uploadedUrl = uploadResponse.data.trim();
        
        if (!uploadedUrl || !uploadedUrl.startsWith('https://files.catbox.moe/')) {
            console.log('Catbox response:', uploadResponse.data);
            throw new Error('Invalid response from Catbox - upload may have failed');
        }
        
        console.log('Upload successful:', uploadedUrl);
        
        // Get file info
        const fileInfo = getFileInfo(mediaMessage, mediaType);
        
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        
        // Send the result
        await socket.sendMessage(sender, {
            text: `✅ *UPLOAD SUCCESSFUL!*\n\n` +
                  `🔗 **Direct URL:**\n${uploadedUrl}\n\n` +
                  `📊 **File Details:**\n` +
                  `📁 Type: ${mediaType.toUpperCase()}\n` +
                  `📏 Size: ${fileSizeMB.toFixed(2)} MB\n` +
                  `📝 Name: ${fileName}\n` +
                  `⏰ Uploaded: ${new Date().toLocaleString()}\n\n` +
                  `${fileInfo}\n` +
                  `💾 *Hosted permanently on Catbox.moe*\n` +
                  `🔗 *Direct link - No ads or redirects*`
        }, { quoted: msg });
        
        // Also send as a clickable link message
        await socket.sendMessage(sender, {
            text: `🔗 Click here: ${uploadedUrl}`
        });
        
    } catch (error) {
        console.error('URL Upload Error:', error);
        
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        
        let errorMessage = '❌ *Upload Failed!*\n\n';
        
        if (error.message.includes('download')) {
            errorMessage += '📥 Could not download the media file\n💡 Try sending the file again';
        } else if (error.message.includes('timeout')) {
            errorMessage += '⏱️ Upload timeout - File may be too large\n💡 Try with a smaller file';
        } else if (error.message.includes('network') || error.code === 'ENOTFOUND') {
            errorMessage += '🌐 Network error - Check internet connection\n💡 Try again in a few moments';
        } else if (error.response && error.response.status === 413) {
            errorMessage += '📊 File too large for server\n💡 Try compressing the file';
        } else if (error.response && error.response.status >= 500) {
            errorMessage += '🛠️ Catbox server error\n💡 Try again later';
        } else {
            errorMessage += `🔧 ${error.message}\n💡 Please try again`;
        }
        
        await socket.sendMessage(sender, {
            text: errorMessage
        });
    }
    break;
}


    //===============================
case 'tts':
case 'speak': {
await socket.sendMessage(sender, { react: { text: '🗣', key: msg.key } });
    const text = body.replace(/^[.!#/](tts|speak)\s*/i, '').trim();
    
    if (!text) {
        return await socket.sendMessage(sender, {
            text: "Please provide text to convert to speech!\nExample: .tts Hello World"
        });
    }
    
    try {
        // Using Google TTS API
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;
        
        await socket.sendMessage(sender, {
            audio: { url: ttsUrl },
            mimetype: 'audio/mpeg',
            ptt: true,
            fileName: 'tts.mp3'
        });
    } catch (error) {
        await socket.sendMessage(sender, { text: "💔Oh sweetie error generating speech." });
    }
    break;
}

    case 'whois': {
        try {
            await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
            const domain = args[0];
            if (!domain) {
                await socket.sendMessage(sender, { text: '📌 Usage: .whois <domain>' }, { quoted: fakevCard });
                break;
            }
            const response = await fetch(`http://api.whois.vu/?whois=${encodeURIComponent(domain)}`);
            const data = await response.json();
            if (!data.domain) {
                throw new Error('Domain not found');
            }
            const whoisMessage = formatMessage(
                '🔍 WHOIS LOOKUP',
                `🌐 Domain: ${data.domain}\n` +
                `📅 Registered: ${data.created_date || 'N/A'}\n` +
                `⏰ Expires: ${data.expiry_date || 'N/A'}\n` +
                `📋 Registrar: ${data.registrar || 'N/A'}\n` +
                `📍 Status: ${data.status.join(', ') || 'N/A'}`,
                'ᴀsᴛʀᴀ-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
            );
            await socket.sendMessage(sender, { text: whoisMessage }, { quoted: fakevCard });
        } catch (error) {
            console.error('Whois command error:', error);
            await socket.sendMessage(sender, { text: '❌ Oh, darling, couldn’t find that domain! 😢 Try again?' }, { quoted: fakevCard });
        }
        break;
    }
      
      case 'repo':
case 'sc':
case 'script': {
    try {
        await socket.sendMessage(sender, { react: { text: '🪄', key: msg.key } });
        const githubRepoURL = 'https://github.com/icebacktech-netizen/iceback-xmd';
        
        const [, username] = githubRepoURL.match(/github\.com\/([^/]+)\/([^/]+)/);
        const response = await fetch(`https://api.github.com/repos/icebacktech-netizen/iceback-xmd`);
        
        if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
        
        const repoData = await response.json();

        const formattedInfo = `
╭──〔 🚀 generalkays ʀᴇᴘᴏ 〕──
│
├─ 𖥸 *ɴᴀᴍᴇ*   : ${repoData.name}
├─ ⭐ *sᴛᴀʀs*    : ${repoData.stargazers_count}
├─ 🍴 *ғᴏʀᴋs*    : ${repoData.forks_count}
├─ 👑 *ᴏᴡɴᴇʀ*   : iceback ᴛᴇᴄʜ
├─ 📜 *ᴅᴇsᴄ* : ${repoData.description || 'ɴ/ᴀ'}
│
╰──〔 *ᴅᴇᴠ iceback ᴛᴇᴄʜ* 〕──
`;

        const repoMessage = {
            image: { url: 'https://files.catbox.moe/9gxtcc.jpg' },
            caption: formattedInfo,
            buttons: [
                {
                    buttonId: `${config.PREFIX}repo-visit`,
                    buttonText: { displayText: '🌐 Visit Repo' },
                    type: 1
                },
                {
                    buttonId: `${config.PREFIX}repo-owner`,
                    buttonText: { displayText: '👑 Owner Profile' },
                    type: 1
                }
                
            ],
            contextInfo: {
                mentionedJid: [m.sender],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.NEWSLETTER_JID || '120363419693990894@newsletter',
                    newsletterName: '🔥iceback ᴛᴇᴄʜ🔥',
                    serverMessageId: 143
                }
            }
        };

        await socket.sendMessage(sender, repoMessage, { quoted: fakevCard });

    } catch (error) {
        console.error("❌ Error in repo command:", error);
        await socket.sendMessage(sender, { 
            text: "⚠️ Failed to fetch repo info. Please try again later." 
        }, { quoted: fakevCard });
    }
    break;
}

case 'repo-visit': {
    await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `🌐 *Click to visit the repo:*\nhttps://github.com/icebackmaster-prog/iceback-mini-bot`,
        contextInfo: {
            externalAdReply: {
                title: 'Visit ICEBACK-MAIN Repository',
                body: 'Open in browser',
                mediaType: 1,
                mediaUrl: 'https://github.com/icebackmaster-prog/iceback-mini-bot',
                sourceUrl: 'https://github.com/icebackmaster-prog/iceback-mini-bot'
            }
        }
    }, { quoted: fakevCard });
    break;
}

case 'repo-owner': {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `👑 *Click to visit the owner profile:*\nhttps://github.com/whitekidtech-netizen'`,
        contextInfo: {
            externalAdReply: {
                title: 'Owner Profile - iceback ᴛᴇᴄʜ',
                body: 'Open in browser',
                mediaType: 1,
                mediaUrl: 'https://github.com/icebacktech-netizen',
                sourceUrl: 'https://github.com/icebacktech-netizen'
            }
        }
    }, { quoted: fakevCard });
    break;
}


// new commands

// ᴄᴀsᴇ ʜᴇʟᴘ

case 'tictactoe':
case 'ttt':
case 'xo': {
await socket.sendMessage(sender, { react: { text: '🎰', key: msg.key || {} } });
    const gameId = sender;
    
    // Initialize games storage if not exists
    if (typeof ticTacToeGames === 'undefined') {
        global.ticTacToeGames = new Map();
    }
    const games = global.ticTacToeGames || new Map();
    
    // Helper functions
    const createGameBoard = () => [
        ['1', '2', '3'],
        ['4', '5', '6'], 
        ['7', '8', '9']
    ];
    
    const formatBoard = (board) => {
        const emojis = {
            'X': '❌', 'O': '⭕',
            '1': '1️⃣', '2': '2️⃣', '3': '3️⃣',
            '4': '4️⃣', '5': '5️⃣', '6': '6️⃣',
            '7': '7️⃣', '8': '8️⃣', '9': '9️⃣'
        };
        
        return `🎮 *TIC TAC TOE BOARD*\n\n` +
               `┏━━━┳━━━┳━━━┓\n` +
               `┃ ${emojis[board[0][0]]} ┃ ${emojis[board[0][1]]} ┃ ${emojis[board[0][2]]} ┃\n` +
               `┣━━━╋━━━╋━━━┫\n` +
               `┃ ${emojis[board[1][0]]} ┃ ${emojis[board[1][1]]} ┃ ${emojis[board[1][2]]} ┃\n` +
               `┣━━━╋━━━╋━━━┫\n` +
               `┃ ${emojis[board[2][0]]} ┃ ${emojis[board[2][1]]} ┃ ${emojis[board[2][2]]} ┃\n` +
               `┗━━━┻━━━┻━━━┛\n`;
    };
    
    // Check if game already exists
    if (games.has(gameId)) {
        const game = games.get(gameId);
        const boardDisplay = formatBoard(game.board);
        
        await socket.sendMessage(sender, {
            text: `${boardDisplay}\n` +
                  `🎯 *Current Game Status*\n` +
                  `👤 Player: ❌ (X)\n` +
                  `🤖 Bot: ⭕ (O)\n` +
                  `🎮 Your turn! Choose 1-9\n\n` +
                  `Type *${config.PREFIX}move <number>* to play\n` +
                  `Type *${config.PREFIX}quit* to end game`,
            buttons: [
                {
                    buttonId: `${config.PREFIX}quit`,
                    buttonText: { displayText: '❌ Quit Game' },
                    type: 1
                }
            ],
            headerType: 1
        });
        break;
    }
    
    // Create new game
    const newGame = {
        board: createGameBoard(),
        currentPlayer: 'X',
        gameMode: 'bot',
        createdAt: Date.now()
    };
    
    games.set(gameId, newGame);
    global.ticTacToeGames = games;
    
    const initialBoard = formatBoard(newGame.board);
    
    await socket.sendMessage(sender, {
        text: `🎮 *NEW TIC TAC TOE GAME STARTED!*\n\n` +
              `${initialBoard}\n` +
              `🎯 *Game Rules:*\n` +
              `• You are ❌ (X)\n` +
              `• Bot is ⭕ (O)\n` +
              `• Choose numbers 1-9 to place your mark\n` +
              `• Get 3 in a row to win!\n\n` +
              `🚀 *Your turn! Type:* *${config.PREFIX}move <1-9>*\n` +
              `📝 *Example:* *${config.PREFIX}move 5*`,
        buttons: [
            {
                buttonId: `${config.PREFIX}quit`,
                buttonText: { displayText: '❌ Quit Game' },
                type: 1
            }
        ],
        headerType: 1
    });
    break;
}

case 'move': {
await socket.sendMessage(sender, { react: { text: '⏩', key: msg.key || {} } });
    const gameId = sender;
    const position = body.split(' ')[1];
    
    // Initialize games storage if not exists
    if (typeof ticTacToeGames === 'undefined') {
        global.ticTacToeGames = new Map();
    }
    const games = global.ticTacToeGames || new Map();
    
    // Helper functions
    const formatBoard = (board) => {
        const emojis = {
            'X': '❌', 'O': '⭕',
            '1': '1️⃣', '2': '2️⃣', '3': '3️⃣',
            '4': '4️⃣', '5': '5️⃣', '6': '6️⃣',
            '7': '7️⃣', '8': '8️⃣', '9': '9️⃣'
        };
        
        return `🎮 *TIC TAC TOE BOARD*\n\n` +
               `┏━━━┳━━━┳━━━┓\n` +
               `┃ ${emojis[board[0][0]]} ┃ ${emojis[board[0][1]]} ┃ ${emojis[board[0][2]]} ┃\n` +
               `┣━━━╋━━━╋━━━┫\n` +
               `┃ ${emojis[board[1][0]]} ┃ ${emojis[board[1][1]]} ┃ ${emojis[board[1][2]]} ┃\n` +
               `┣━━━╋━━━╋━━━┫\n` +
               `┃ ${emojis[board[2][0]]} ┃ ${emojis[board[2][1]]} ┃ ${emojis[board[2][2]]} ┃\n` +
               `┗━━━┻━━━┻━━━┛\n`;
    };
    
    const checkWin = (board) => {
        // Check rows
        for (let i = 0; i < 3; i++) {
            if (board[i][0] === board[i][1] && board[i][1] === board[i][2] && 
                (board[i][0] === 'X' || board[i][0] === 'O')) {
                return board[i][0];
            }
        }
        
        // Check columns
        for (let i = 0; i < 3; i++) {
            if (board[0][i] === board[1][i] && board[1][i] === board[2][i] && 
                (board[0][i] === 'X' || board[0][i] === 'O')) {
                return board[0][i];
            }
        }
        
        // Check diagonals
        if (board[0][0] === board[1][1] && board[1][1] === board[2][2] && 
            (board[0][0] === 'X' || board[0][0] === 'O')) {
            return board[0][0];
        }
        
        if (board[0][2] === board[1][1] && board[1][1] === board[2][0] && 
            (board[0][2] === 'X' || board[0][2] === 'O')) {
            return board[0][2];
        }
        
        return null;
    };
    
    const isBoardFull = (board) => {
        return board.flat().every(cell => cell === 'X' || cell === 'O');
    };
    
    const makeMove = (board, position, symbol) => {
        const pos = parseInt(position);
        if (pos < 1 || pos > 9) return false;
        
        const row = Math.floor((pos - 1) / 3);
        const col = (pos - 1) % 3;
        
        if (board[row][col] === 'X' || board[row][col] === 'O') {
            return false;
        }
        
        board[row][col] = symbol;
        return true;
    };
    
    const getBotMove = (board) => {
        // Check if bot can win
        for (let i = 1; i <= 9; i++) {
            const testBoard = board.map(row => [...row]);
            if (makeMove(testBoard, i.toString(), 'O')) {
                if (checkWin(testBoard) === 'O') {
                    return i.toString();
                }
            }
        }
        
        // Check if bot needs to block player
        for (let i = 1; i <= 9; i++) {
            const testBoard = board.map(row => [...row]);
            if (makeMove(testBoard, i.toString(), 'X')) {
                if (checkWin(testBoard) === 'X') {
                    return i.toString();
                }
            }
        }
        
        // Take center if available
        if (board[1][1] !== 'X' && board[1][1] !== 'O') {
            return '5';
        }
        
        // Take corners
        const corners = ['1', '3', '7', '9'];
        const availableCorners = corners.filter(corner => {
            const pos = parseInt(corner);
            const row = Math.floor((pos - 1) / 3);
            const col = (pos - 1) % 3;
            return board[row][col] !== 'X' && board[row][col] !== 'O';
        });
        
        if (availableCorners.length > 0) {
            return availableCorners[Math.floor(Math.random() * availableCorners.length)];
        }
        
        // Take any available position
        for (let i = 1; i <= 9; i++) {
            const pos = parseInt(i);
            const row = Math.floor((pos - 1) / 3);
            const col = (pos - 1) % 3;
            if (board[row][col] !== 'X' && board[row][col] !== 'O') {
                return i.toString();
            }
        }
        
        return null;
    };
    
    if (!games.has(gameId)) {
        await socket.sendMessage(sender, {
            text: `❌ *No active game found!*\n\n` +
                  `Start a new game with *${config.PREFIX}tictactoe*`
        });
        break;
    }
    
    if (!position) {
        await socket.sendMessage(sender, {
            text: `❌ *Invalid move!*\n\n` +
                  `Usage: *${config.PREFIX}move <1-9>*\n` +
                  `Example: *${config.PREFIX}move 5*`
        });
        break;
    }
    
    const game = games.get(gameId);
    
    // Make player move
    if (!makeMove(game.board, position, 'X')) {
        await socket.sendMessage(sender, {
            text: `❌ *Invalid move!*\n\n` +
                  `• Position must be 1-9\n` +
                  `• Position must be empty\n\n` +
                  `Try again with *${config.PREFIX}move <number>*`
        });
        break;
    }
    
    // Check if player won
    const playerWin = checkWin(game.board);
    if (playerWin === 'X') {
        const finalBoard = formatBoard(game.board);
        await socket.sendMessage(sender, {
            text: `🎉 *CONGRATULATIONS! YOU WON!* 🎉\n\n` +
                  `${finalBoard}\n` +
                  `🏆 You beat the bot!\n` +
                  `🎯 Great strategy!\n\n` +
                  `Play again with *${config.PREFIX}tictactoe*`,
            buttons: [
                {
                    buttonId: `${config.PREFIX}tictactoe`,
                    buttonText: { displayText: '🔄 Play Again' },
                    type: 1
                }
            ]
        });
        games.delete(gameId);
        global.ticTacToeGames = games;
        break;
    }
    
    // Check if board is full (tie)
    if (isBoardFull(game.board)) {
        const finalBoard = formatBoard(game.board);
        await socket.sendMessage(sender, {
            text: `🤝 *IT'S A TIE!* 🤝\n\n` +
                  `${finalBoard}\n` +
                  `📍 Great game! Nobody wins this time.\n\n` +
                  `Play again with *${config.PREFIX}tictactoe*`,
            buttons: [
                {
                    buttonId: `${config.PREFIX}tictactoe`,
                    buttonText: { displayText: '🔄 Play Again' },
                    type: 1
                }
            ]
        });
        games.delete(gameId);
        global.ticTacToeGames = games;
        break;
    }
    
    // Bot's turn
    const botMove = getBotMove(game.board);
    if (botMove) {
        makeMove(game.board, botMove, 'O');
        
        // Check if bot won
        const botWin = checkWin(game.board);
        if (botWin === 'O') {
            const finalBoard = formatBoard(game.board);
            await socket.sendMessage(sender, {
                text: `🤖 *BOT WINS!* 🤖\n\n` +
                      `${finalBoard}\n` +
                      `🎯 Bot played position ${botMove}\n` +
                      `💪 Better luck next time!\n\n` +
                      `Play again with *${config.PREFIX}tictactoe*`,
                buttons: [
                    {
                        buttonId: `${config.PREFIX}tictactoe`,
                        buttonText: { displayText: '🔄 Play Again' },
                        type: 1
                    }
                ]
            });
            games.delete(gameId);
            global.ticTacToeGames = games;
            break;
        }
        
        // Check for tie after bot move
        if (isBoardFull(game.board)) {
            const finalBoard = formatBoard(game.board);
            await socket.sendMessage(sender, {
                text: `🤝 *IT'S A TIE!* 🤝\n\n` +
                      `${finalBoard}\n` +
                      `🎯 Bot played position ${botMove}\n` +
                      `📍 Great game! Nobody wins.\n\n` +
                      `Play again with *${config.PREFIX}tictactoe*`,
                buttons: [
                    {
                        buttonId: `${config.PREFIX}tictactoe`,
                        buttonText: { displayText: '🔄 Play Again' },
                        type: 1
                    }
                ]
            });
            games.delete(gameId);
            global.ticTacToeGames = games;
            break;
        }
        
        // Continue game - save updated game state
        games.set(gameId, game);
        global.ticTacToeGames = games;
        
        const currentBoard = formatBoard(game.board);
        await socket.sendMessage(sender, {
            text: `${currentBoard}\n` +
                  `🤖 *Bot played position ${botMove}*\n\n` +
                  `🎯 *Your turn! Choose 1-9*\n` +
                  `Type: *${config.PREFIX}move <number>*`,
            buttons: [
                {
                    buttonId: `${config.PREFIX}quit`,
                    buttonText: { displayText: '❌ Quit Game' },
                    type: 1
                }
            ]
        });
    }
    break;
}

case 'quit':
case 'quitgame': {
await socket.sendMessage(sender, { react: { text: '🚯', key: msg.key || {} } });
    const gameId = sender;
    
    // Initialize games storage if not exists
    if (typeof ticTacToeGames === 'undefined') {
        global.ticTacToeGames = new Map();
    }
    const games = global.ticTacToeGames || new Map();
    
    if (!games.has(gameId)) {
        await socket.sendMessage(sender, {
            text: `❌ *No active game to quit!*`
        });
        break;
    }
    
    games.delete(gameId);
    global.ticTacToeGames = games;
    
    await socket.sendMessage(sender, {
        text: `🚪 *Game ended!*\n\n` +
              `Thanks for playing Tic Tac Toe!\n` +
              `Start a new game anytime with *${config.PREFIX}tictactoe*`,
        buttons: [
            {
                buttonId: `${config.PREFIX}tictactoe`,
                buttonText: { displayText: '🎮 New Game' },
                type: 1
            }
        ]
    });
    break;
}

// case tictactoe menu
case 'gmenu':
case 'gamemenu': {
  try {
    await socket.sendMessage(sender, { react: { text: '🎮', key: msg.key } });
    
    let gameText = `
╭─『 *🎮 ɢᴀᴍᴇ ᴍᴇɴᴜ* 』─╮
│ 🤖 *ɴᴀᴍᴇ*: iceback-ᴍᴅ ᴍɪɴɪ
│ 📍 *ᴘʀᴇғɪx*: ${config.PREFIX}
│ 🔮 *ᴄᴍᴅs*: 3
│ 🇿🇼 *ᴏᴡɴᴇʀ*: iceback ᴛᴇᴄʜ
╰─────────────

╭─『 🎮 *ɢᴀᴍᴇ ᴄᴅᴍs* 』─╮
│ 🎰 *1. \`tictactoe\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: sᴛᴀʀᴛ ɢᴀᴍᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴛɪᴄᴛᴀᴄᴛᴏᴇ
│
│ ⏩ *1. \`move\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴍᴏᴠᴇ ᴀ <ɴᴜᴍʙᴇʀ>
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ᴍᴏᴠᴇ 
│
│ 🚷 *1. \`quit\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴇxɪᴛ ɢᴀᴍᴇ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}ϙᴜɪᴛ
│ 
│ 🙃 ᴍᴏʀᴇ ɢᴀᴍᴇs ᴄᴏᴍᴍɪɴɢ
╰─────────
 
> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ*
`;

    await socket.sendMessage(from, {
      image: { url: "https://files.catbox.moe/mp8yoj.png" },
      caption: gameText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('game command error:', error);
    await socket.sendMessage(from, {
      text: `❌ *Oh, darling, the menu got shy! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}

//================================
case 'pmenu':
case 'premiummenu': {
    try {
        await socket.sendMessage(sender, { react: { text: '🪄', key: msg.key } });
        
        const formattedInfo = `
╭──〔  generalkays ᴘʀᴇᴍɪᴜᴍ ᴄᴍᴅs 〕──
│
│ ✒️ *1. \`Prefix\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄʜᴀɴɢᴇ ʙᴏᴛ ᴘʀᴇғɪx
│   - ᴜsᴀɢᴇ: ${config.PREFIX}setprefix
│
│ 👤 *2. \`setmode\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴄʜᴀɴɢᴇ ʙᴏᴛ ᴜsᴇ ᴇɪᴛʜᴇʀ sᴇʟғ ᴏʀ ᴘᴜʙʟɪᴄ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}setmode 
│
│ 😎 *3. \`Auto view status\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴇɴᴀʙʟᴇ / ᴅɪsᴀʙʟᴇ sᴛᴀᴛᴜs ᴠɪᴇᴡɪɴɢ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}setautoview ᴛʀᴜᴇ /ғᴀʟsᴇ
│
│ 💚 *4. \`auto like status\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴇɴᴀʙʟᴇ /ᴅɪsᴀʙʟᴇ ʟɪᴋɪɴɢ sᴛᴀᴛᴜsᴇs
│   - ᴜsᴀɢᴇ: ${config.PREFIX}setautolike ᴛʀᴜᴇ/ ғᴀʟsᴇ
│
│ 📟 *5. \`setautorecording\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴅɪsᴀʙʟᴇ /ᴇɴᴀʙʟᴇ ᴀᴜᴛᴏʀᴇᴄᴏʀᴅɪɴɢ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}setautorecording ᴛʀᴜᴇ /ғᴀʟsᴇ
│
│ 🔐 *6. \`Verifyotp\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴠᴇʀɪғʏ 
│   - ᴜsᴀɢᴇ: ${config.PREFIX}verifyotp
│
│ 😜 *7. \`ᴀᴅᴅᴘʀᴇᴍɪᴜᴍ\`*
│   - ᴅᴇsᴄʀɪᴘᴛɪᴏɴ: ᴏᴡɴᴇʀ ᴏɴʟʏ
│   - ᴜsᴀɢᴇ: ${config.PREFIX}addpremium
│ 
╰──〔 *ᴅᴇᴠ iceback ᴛᴇᴄʜ* 〕──
`;

        const repoMessage = {
            image: { url: 'https://files.catbox.moe/mp8yoj.png' },
            caption: formattedInfo,
            buttons: [
                {
                    buttonId: `${config.PREFIX}allmenu`,
                    buttonText: { displayText: '🌐 vɪᴇᴡ ᴀʟʟ ᴄᴍᴅs' },
                    type: 1
                },
                {
                    buttonId: `${config.PREFIX}buy`,
                    buttonText: { displayText: '👑 ʙᴜʏ ᴘʀᴇᴍɪᴜᴍ' },
                    type: 1
                },
                {
                    buttonId: `${config.PREFIX}repo-audio`,
                    buttonText: { displayText: '🎵 Play Intro' },
                    type: 1
                }
            ],
            contextInfo: {
                mentionedJid: [m.sender],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.NEWSLETTER_JID || '120363419693990894@newsletter',
                    newsletterName: '🔥iceback-ᴍᴅ ᴍɪɴɪ🔥',
                    serverMessageId: 143
                }
            }
        };

        await socket.sendMessage(sender, repoMessage, { quoted: fakevCard });

    } catch (error) {
        console.error("❌ Error in repo command:", error);
        await socket.sendMessage(sender, { 
            text: "⚠️ Failed to fetch repo info. Please try again later." 
        }, { quoted: fakevCard });
    }
    break;
}

case "buy": {
    try {
        await socket.sendMessage(sender, { react: { text: '⭐', key: msg.key } });
        
        const premiumText = `
╭═✦〔 ⭐ *ᴘʀᴇᴍɪᴜᴍ ᴀᴄᴄᴇss* 〕✦═╮
│
│ ✨ *ʙᴇɴᴇғɪᴛs:*
│ ➸ ɴᴏ ᴀᴅs
│ ➸ ғᴀsᴛᴇʀ ʀᴇsᴘᴏɴsᴇ
│ ➸ ᴇxᴄʟᴜsɪᴠᴇ ғᴇᴀᴛᴜʀᴇs
│ ➸ ᴘʀɪᴏʀɪᴛʏ sᴜᴘᴘᴏʀᴛ
│
│ 💰 *ᴘʀɪᴄɪɴɢ:*
│ ➸ 1 ᴍᴏɴᴛʜ: $3 (ᴍɪɴɪ ʙᴏᴛ)
│ ➸ 3 ᴍᴏɴᴛʜs: $7 (ғᴜʟʟ ʙᴏᴛ)
│ ➸ 6 ᴍᴏɴᴛʜs: $14 (ғᴜʟʟ ʙᴏᴛ)
│ ➸ ʟɪғᴇᴛɪᴍᴇ:....
│
│ 📧 *ᴄᴏɴᴛᴀᴄᴛ:*
│ ➸ ᴡʜᴀᴛsᴀᴘᴘ: ${config.OWNER_NUMBER || '263788377887'}
│ ➸ ᴘᴀʏᴍᴇɴᴛ: ᴇᴄᴏᴄᴀꜱʜ 
│
│ ⚡ *ᴄᴜʀʀᴇɴᴛʟʏ:* 🔄'}
╰═⚬⚬⚬⚬⚬⚬⚬⚬⚬⚬⚬⚬⚬⚬═╯`;

        await socket.sendMessage(sender, { text: premiumText }, { quoted: fakevCard });
        break;

    } catch (error) {
        console.error('❌ Premium command error:', error.message);
        await socket.sendMessage(sender, { text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ sʜᴏᴡ ᴘʀᴇᴍɪᴜᴍ ɪɴғᴏ.' }, { quoted: fakevCard });
        break;
    }
}
 // one hell of mind tiring thinking              
                case 'delete':
                case 'del': {
                    if (!msg.quoted) {
                        return await socket.sendMessage(msg.key.remoteJid, {
                            text: "Reply to a message to delete it!"
                        });
                    }
                    
                    if (msg.key.remoteJid.endsWith('@g.us')) {
                        try {
                            const groupMetadata = await socket.groupMetadata(msg.key.remoteJid);
                            const participants = groupMetadata.participants;
                            const userParticipant = participants.find(p => p.id === sender);
                            
                            const isUserAdmin = userParticipant?.admin === 'admin' || userParticipant?.admin === 'superadmin';
                            if (!isUserAdmin) {
                                return await socket.sendMessage(msg.key.remoteJid, {
                                    text: "❌ Only admins can delete messages in groups!"
                                });
                            }
                        } catch (error) {
                            return await socket.sendMessage(msg.key.remoteJid, {
                                text: "❌ Error checking permissions."
                            });
                        }
                    }
                    
                    try {
                        await socket.sendMessage(msg.key.remoteJid, {
                            delete: msg.quoted.key
                        });
                    } catch (error) {
                        await socket.sendMessage(msg.key.remoteJid, {
                            text: "❌ Error deleting message. Bot might not have permission."
                        });
                    }
                    break;
                }


                case 'qr':
                case 'qrcode': {
                    const text = body.replace(new RegExp(`^[${prefix}](qr|qrcode)\\s*`, 'i'), '').trim();
                    
                    if (!text) {
                        return await socket.sendMessage(sender, {
                            text: `Please provide text to generate QR code!\nExample: ${prefix}qr https://google.com`
                        });
                    }
                    
                    try {
                        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
                        
                        await socket.sendMessage(sender, {
                            image: { url: qrUrl },
                            caption: `QR Code generated for: ${text}`
                        });
                    } catch (error) {
                        await socket.sendMessage(sender, { text: "Error generating QR code." });
                    }
                    break;
                }

                case 'deleteme': {
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            'ᴀsᴛʀᴀᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                        )
                    });
                    break;
                }

                case 'setprefix': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ Only the bot owner can change the prefix!'
                        });
                        return;
                    }

                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `Please provide a new prefix!\nExample: ${prefix}setprefix !`
                        });
                        return;
                    }

                    const newPrefix = args[0];
                    if (newPrefix.length > 2) {
                        await socket.sendMessage(sender, {
                            text: '❌ Prefix must be 1 or 2 characters long!'
                        });
                        return;
                    }

                    const otp = generateOTP();
                    otpStore.set(sanitizedNumber, {
                        otp,
                        expiry: Date.now() + config.OTP_EXPIRY,
                        newConfig: { ...userConfig, PREFIX: newPrefix }
                    });

                    await sendOTP(socket, sanitizedNumber, otp);
                    await socket.sendMessage(sender, {
                        text: `✅ OTP sent to your number to confirm prefix change to "${newPrefix}". Reply with ${prefix}verifyotp <otp>`
                    });
                    break;
                }

                case 'setmode': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ Only the bot owner can change the mode!'
                        });
                        return;
                    }

                    if (args.length === 0 || !['self', 'public'].includes(args[0].toLowerCase())) {
                        await socket.sendMessage(sender, {
                            text: `Please specify a valid mode: self or public\nExample: ${prefix}setmode public`
                        });
                        return;
                    }

                    const newMode = args[0].toLowerCase();
                    const otp = generateOTP();
                    otpStore.set(sanitizedNumber, {
                        otp,
                        expiry: Date.now() + config.OTP_EXPIRY,
                        newConfig: { ...userConfig, MODE: newMode }
                    });

                    await sendOTP(socket, sanitizedNumber, otp);
                    await socket.sendMessage(sender, {
                        text: `✅ OTP sent to your number to confirm mode change to "${newMode}". Reply with ${prefix}verifyotp <otp>`
                    });
                    break;
                }

                case 'verifyotp': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ Only the bot owner can verify OTP!'
                        });
                        return;
                    }

                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `Please provide the OTP!\nExample: ${prefix}verifyotp 123456`
                        });
                        return;
                    }

                    const otp = args[0];
                    const storedData = otpStore.get(sanitizedNumber);
                    if (!storedData) {
                        await socket.sendMessage(sender, {
                            text: '❌ No OTP request found for this number!'
                        });
                        return;
                    }

                    if (Date.now() >= storedData.expiry) {
                        otpStore.delete(sanitizedNumber);
                        await socket.sendMessage(sender, {
                            text: '❌ OTP has expired! Please request a new one.'
                        });
                        return;
                    }

                    if (storedData.otp !== otp) {
                        await socket.sendMessage(sender, {
                            text: '❌ Invalid OTP! Please try again.'
                        });
                        return;
                    }

                    userConfig = storedData.newConfig;
                    await updateUserConfig(sanitizedNumber, userConfig);
                    otpStore.delete(sanitizedNumber);

                    const changeMessage = userConfig.PREFIX !== config.PREFIX
                        ? `Prefix changed to "${userConfig.PREFIX}"`
                        : `Mode changed to "${userConfig.MODE}"`;

                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '📌 CONFIG UPDATED',
                            `✅ ${changeMessage}`,
                            'ᴀsᴛʀᴀ-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                        )
                    });
                    break;
                }
                
                case 'ig2': {
                await socket.sendMessage(sender, { react: { text: '✅️', key: msg.key } });
                    const axios = require('axios');
                    const { igdl } = require('ruhend-scraper'); 
                        

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const igUrl = q?.trim(); 
                    
                    if (!/instagram\.com/.test(igUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *Give me a real Instagram video link, darling 😘*' });
                    }

                    try {
                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        const res = await igdl(igUrl);
                        const data = res.data; 

                        if (data && data.length > 0) {
                            const videoUrl = data[0].url; 

                            await socket.sendMessage(sender, {
                                video: { url: videoUrl },
                                mimetype: 'video/mp4',
                                caption: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ'
                            }, { quoted: fakevCard });

                            await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                        } else {
                            await socket.sendMessage(sender, { text: '*❌ No video found in that link, love! Try another? 💔*' });
                        }
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ Oh, sweetie, that Instagram video got away! 😢*' });
                    }
                    break;
                }
//===============================     

case 'news': {
                await socket.sendMessage(sender, { react: { text: '😒', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                        if (!response.ok) {
                            throw new Error('Failed to fetch news from API');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                            throw new Error('Invalid news data received');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage;
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '📰 iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ 📰',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`,
                                'iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ  '
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'news' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, sweetie, the news got lost in the wind! 😢 Try again?'
                        });
                    }
                    break;
                }
//===============================

   case 'wame': {
    try {
        let targetNumber = '';
        let customText = '';

        if (msg.message.extendedTextMessage?.contextInfo?.participant) {
            targetNumber = msg.message.extendedTextMessage.contextInfo.participant.split('@')[0];
            customText = args.join(' ');
        }
        else if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetNumber = msg.message.extendedTextMessage.contextInfo.mentionedJid[0].split('@')[0];
            customText = args.join(' ');
        }
        else if (args[0]) {
            targetNumber = args[0].replace(/[^0-9]/g, '');
            customText = args.slice(1).join(' ');
        }
        else {
            targetNumber = sender.split('@')[0];
            customText = args.join(' ');
        }

        let waLink = `https://wa.me/${targetNumber}`;
        if (customText) {
            waLink += `?text=${encodeURIComponent(customText)}`;
        }

        await socket.sendMessage(sender, {
            image: { url: config.IMAGE_PATH },
            caption: formatMessage(
                '🔗 𝐖𝐇𝐀𝐓𝐒𝐀𝐏𝐏 𝐋𝐈𝐍𝐊 𝐆𝐄𝐍𝐄𝐑𝐀𝐓𝐄𝐃',
                `📱 *Number:* ${targetNumber}\n🔗 *Link:* ${waLink}\n${customText ? `💬 *Message:* ${customText}` : ''}`,
                'ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ'
            ),
            contextInfo: {
                externalAdReply: {
                    title: `Chat with ${targetNumber}`,
                    body: "Click to open WhatsApp chat",
                    thumbnailUrl: config.IMAGE_PATH,
                    sourceUrl: waLink,
                    mediaType: 1,
                    renderLargerThumbnail: true
                }
            }
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('❌ WAME error:', error);
        await socket.sendMessage(sender, {
            text: '*❌ Failed to generate WhatsApp link*'
        }, { quoted: fakevCard });
    }
    break;
}




                case 'xvideo': {
                    try {
                        if (!args[0]) {
                            return await socket.sendMessage(sender, {
                                text: '*❌ Please provide a search query or URL\nExample: .xvideo mia*'
                            }, { quoted: fakevCard });
                        }

                        let video = null, isURL = false;
                        if (!args[0].startsWith('http')) {
                            await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

                            const searchResponse = await axios.get(`https://saviya-kolla-api.koyeb.app/search/xvideos?query=${args.join(' ')}`);

                            if (!searchResponse.data.status || !searchResponse.data.result || searchResponse.data.result.length === 0) {
                                throw new Error('No results found');
                            }

                            video = searchResponse.data.result[0];

                        } else { 
                            video = args[0];
                            isURL = true;
                        }

                        const dlResponse = await axios.get(`https://saviya-kolla-api.koyeb.app/download/xvideos?url=${encodeURIComponent(isURL ? video : video.url)}`);
                        if (!dlResponse.data.status) throw new Error('Download API failed');

                        const dl = dlResponse.data.result;

                        await socket.sendMessage(sender, {
                            video: { url: dl.url },
                            caption: `*📹 ${dl.title}*\n\n⏱️ ${isURL ?  "" : `Duration: ${video.duration}`}\n👁️ Views: ${dl.views}\n👍 Likes: ${dl.likes} | 👎 Dislikes: ${dl.dislikes}\n\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ`,
                            mimetype: 'video/mp4'
                        }, { quoted: fakevCard });

                    } catch (error) {
                        console.error('❌ XVideo error:', error);
                        await socket.sendMessage(sender, {
                            text: '*❌ Failed to fetch video*'
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                
                
                case 'yts': {
                    try {
                        if (!args[0]) {
                            return await socket.sendMessage(sender, {
                                text: '*❌ Please provide a search query*\n*Usage:* .yts <search term>'
                            }, { quoted: fakevCard });
                        }

                        const query = args.join(' ');
                        await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

                        const searchResults = await yts(query);

                        if (!searchResults || !searchResults.videos || searchResults.videos.length === 0) {
                            return await socket.sendMessage(sender, {
                                text: `*❌ No results found for:* ${query}`
                            }, { quoted: fakevCard });
                        }

                        const videos = searchResults.videos.slice(0, 5);

                        let resultText = `*🔍 𝐘𝐎𝐔𝐓𝐔𝐁𝐄 𝐒𝐄𝐀𝐑𝐂𝐇 𝐑𝐄𝐒𝐔𝐋𝐓𝐒*\n`;
                        resultText += `*Query:* ${query}\n`;
                        resultText += `*Found:* ${searchResults.videos.length} videos\n`;
                        resultText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

                        videos.forEach((video, index) => {
                            resultText += `*${index + 1}. ${video.title}*\n`;
                            resultText += `⏱️ Duration: ${video.timestamp}\n`;
                            resultText += `👁️ Views: ${video.views ? video.views.toLocaleString() : 'N/A'}\n`;
                            resultText += `📅 Uploaded: ${video.ago}\n`;
                            resultText += `👤 Channel: ${video.author.name}\n`;
                            resultText += `🔗 Link: ${video.url}\n`;
                            resultText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                        });

                        resultText += `> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ*\n`;
                        resultText += `> *Tip:* Use .song <title/url> to download audio`;

                        await socket.sendMessage(sender, {
                            image: { url: videos[0].thumbnail },
                            caption: resultText,
                            contextInfo: {
                                externalAdReply: {
                                    title: videos[0].title,
                                    body: `${videos[0].author.name} • ${videos[0].timestamp}`,
                                    thumbnailUrl: videos[0].thumbnail,
                                    sourceUrl: videos[0].url,
                                    mediaType: 1,
                                    renderLargerThumbnail: true
                                }
                            }
                        }, { quoted: fakevCard });

                        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

                    } catch (error) {
                        console.error('❌ YouTube search error:', error);
                        await socket.sendMessage(sender, {
                            text: `*❌ Search failed*\n*Error:* ${error.message}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                
                case 'vv':
                case 'viewonce': {
                    try {
                        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

                        if (!quotedMsg) {
                            return await socket.sendMessage(sender, {
                                text: '❌ *Please reply to a ViewOnce message!*\n\n📌 Usage: Reply to a viewonce message with `.vv`'
                            }, { quoted: fakevCard });
                        }

                        await socket.sendMessage(sender, {
                            react: { text: '✨', key: msg.key }
                        });

                        let mediaData = null;
                        let mediaType = null;
                        let caption = '';

                        // Check for viewonce media
                        if (quotedMsg.imageMessage?.viewOnce) {
                            mediaData = quotedMsg.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.videoMessage?.viewOnce) {
                            mediaData = quotedMsg.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessage?.message?.imageMessage) {
                            mediaData = quotedMsg.viewOnceMessage.message.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessage?.message?.videoMessage) {
                            mediaData = quotedMsg.viewOnceMessage.message.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessageV2?.message?.imageMessage) {
                            mediaData = quotedMsg.viewOnceMessageV2.message.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessageV2?.message?.videoMessage) {
                            mediaData = quotedMsg.viewOnceMessageV2.message.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else {
                            return await socket.sendMessage(sender, {
                                text: '❌ *This is not a ViewOnce message or it has already been viewed!*'
                            }, { quoted: fakevCard });
                        }

                        if (mediaData && mediaType) {
                            await socket.sendMessage(sender, {
                                text: '⏳ *Retrieving ViewOnce media...*'
                            }, { quoted: fakevCard });

                            const buffer = await downloadAndSaveMedia(mediaData, mediaType);

                            const messageContent = caption ?
                                `✅ *ViewOnce ${mediaType} Retrieved*\n\n📝 Caption: ${caption}` :
                                `✅ *ViewOnce ${mediaType} Retrieved*`;

                            if (mediaType === 'image') {
                                await socket.sendMessage(sender, {
                                    image: buffer,
                                    caption: messageContent
                                }, { quoted: fakevCard });
                            } else if (mediaType === 'video') {
                                await socket.sendMessage(sender, {
                                    video: buffer,
                                    caption: messageContent
                                }, { quoted: fakevCard });
                            }

                            await socket.sendMessage(sender, {
                                react: { text: '✅', key: msg.key }
                            });

                            console.log(`✅ ViewOnce ${mediaType} retrieved for ${sender}`);
                        }

                    } catch (error) {
                        console.error('ViewOnce Error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to retrieve ViewOnce*\n\nError: ${error.message}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                
                
                
                case 'owner': {
                    const ownerVCard = `BEGIN:VCARD\nVERSION:3.0\nFN:Malvin King\nTEL;type=CELL;type=VOICE;waid=263787337998:+263789846423\nEND:VCARD`;

                    await socket.sendMessage(sender, {
                        contacts: {
                            displayName: 'ᴡʜɪᴛᴇᴋɪᴅ ᴛᴇᴄʜ',
                            contacts: [{ vcard: ownerVCard }]
                        }
                    }, { quoted: fakevCard });

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(
                            '𝐎𝐖𝐍𝐄𝐑 𝐈𝐍𝐅𝐎𝐑𝐌𝐀𝐓𝐈𝐎𝐍',
                            `👤 *Name:* iceback Tech\n📱 *Number:* +263788377887\n🌐 *Website:* http//soon\n💼 *Role:* Bot Developer & Owner`,
                            'ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ'
                        )
                    }, { quoted: fakevCard });
                    break;
                }
                
                case 'video': {
    try {
        if (!args[0]) {
            return await socket.sendMessage(sender, {
                text: '*❌ Please provide a YouTube URL or search query*\n*Usage:* .video <URL or search term>'
            }, { quoted: fakevCard });
        }

        const query = args.join(' ');
        let videoUrl = query;

        // If not a URL, search for it
        if (!query.includes('youtube.com') && !query.includes('youtu.be')) {
            await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

            const search = await yts(query);
            if (!search?.videos || search.videos.length === 0) {
                return await socket.sendMessage(sender, {
                    text: '*❌ No videos found*'
                }, { quoted: fakevCard });
            }

            videoUrl = search.videos[0].url;
        }

        await socket.sendMessage(sender, { react: { text: '⬇️', key: fakevCard.key } });

        const response = await axios.get(`https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(videoUrl)}`);

        if (response.data.status !== 200 || !response.data.success) {
            throw new Error('Failed to fetch video');
        }

        const { title, quality, thumbnail, download_url } = response.data.result;

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            video: { url: download_url },
            caption: formatMessage(
                '🎬 𝐘𝐎𝐔𝐓𝐔𝐁𝐄 𝐕𝐈𝐃𝐄𝐎',
                `📹 *Title:* ${title}\n📊 *Quality:* ${quality}`,
                'ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ'
            )
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('❌ Video download error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `*❌ Failed to download video*\n\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}

case 'movie': {
    try {
        if (!args[0]) {
            return await socket.sendMessage(sender, {
                text: '*❌ Please provide a movie name*\n*Usage:* .movie Deadpool'
            }, { quoted: fakevCard });
        }

        const movieQuery = args.join(' ');

        await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

        const response = await axios.get(`https://apis.davidcyriltech.my.id/movies/search?query=${encodeURIComponent(movieQuery)}`);

        if (!response.data || !response.data.results || response.data.results.length === 0) {
            return await socket.sendMessage(sender, {
                text: `*❌ No movies found for:* ${movieQuery}`
            }, { quoted: fakevCard });
        }

        const movies = response.data.results.slice(0, 5);

        let movieText = `*🎬 𝐌𝐎𝐕𝐈𝐄 𝐒𝐄𝐀𝐑𝐂𝐇 𝐑𝐄𝐒𝐔𝐋𝐓𝐒*\n`;
        movieText += `*Query:* ${movieQuery}\n`;
        movieText += `*Found:* ${response.data.results.length} movies\n`;
        movieText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

        movies.forEach((movie, index) => {
            movieText += `*${index + 1}. ${movie.title}*\n`;
            if (movie.year) movieText += `📅 Year: ${movie.year}\n`;
            if (movie.genre) movieText += `🎭 Genre: ${movie.genre}\n`;
            if (movie.rating) movieText += `⭐ Rating: ${movie.rating}\n`;
            if (movie.link) movieText += `🔗 Link: ${movie.link}\n`;
            movieText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
        });

        movieText += `> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ*\n`;
        movieText += `> *Source:* SinhalaSubu`;

        await socket.sendMessage(sender, {
            image: { url: movies[0].thumbnail || config.IMAGE_PATH },
            caption: movieText
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('❌ Movie search error:', error);
        await socket.sendMessage(sender, {
            text: `*❌ Failed to search movies*\n\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
                
                
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    'iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            console.log(`Deleted GitHub session file: ${file.name}`);
        }

        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
            await updateNumberListOnGitHub(sanitizedNumber);
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const userConfig = JSON.parse(content);
        return {
            ...config,
            ...userConfig,
            PREFIX: userConfig.PREFIX || config.PREFIX,
            MODE: userConfig.MODE || config.MODE
        };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                console.log(`User ${number} logged out. Deleting session...`);
                
                await deleteSessionFromGitHub(number);
                
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            'ᴀsᴛʀᴀ-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const userConfig = await loadUserConfig(sanitizedNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            let sha;
            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`
                });
                sha = data.sha;
            } catch (error) {
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: `session/creds_${sanitizedNumber}.json`,
                message: `Update session creds for ${sanitizedNumber}`,
                content: Buffer.from(fileContent).toString('base64'),
                sha
            });
            console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, userConfig);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'ᴊᴏɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ'
                        : `ғᴀɪʟᴇᴅ ᴛᴏ ᴊᴏɪɴ ɢʀᴏᴜᴘ: ${groupResult.error}`;

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🤝 ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ',
                            `✅ sᴜᴄᴄᴇssғᴜʟʟʏ ᴄᴏɴɴᴇᴄᴛᴇᴅ!\n\n` +
                            `🔢 ɴᴜᴍʙᴇʀ: ${sanitizedNumber}\n` +
                            `📢 ғᴏʟʟᴏᴡ ᴍᴀɪɴ ᴄʜᴀɴɴᴇʟs 👇\n` +
                            `🤖 ᴛʏᴘᴇ *${userConfig.PREFIX}menu* ᴛᴏ ɢᴇᴛ sᴛᴀʀᴛᴇᴅ!`,
                            '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ iceback ᴛᴇᴄʜ'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    try {
                        if (fs.existsSync(NUMBER_LIST_PATH)) {
                            const fileContent = fs.readFileSync(NUMBER_LIST_PATH, 'utf8');
                            numbers = JSON.parse(fileContent) || [];
                        }
                        
                        if (!numbers.includes(sanitizedNumber)) {
                            numbers.push(sanitizedNumber);
                            
                            if (fs.existsSync(NUMBER_LIST_PATH)) {
                                fs.copyFileSync(NUMBER_LIST_PATH, NUMBER_LIST_PATH + '.backup');
                            }
                            
                            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                            console.log(`📝 Added ${sanitizedNumber} to number list`);
                            
                            try {
                                await updateNumberListOnGitHub(sanitizedNumber);
                                console.log(`☁️ GitHub updated for ${sanitizedNumber}`);
                            } catch (githubError) {
                                console.warn(`⚠️ GitHub update failed:`, githubError.message);
                            }
                        }
                    } catch (fileError) {
                        console.error(`❌ File operation failed:`, fileError.message);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'ICEBACK-MINI-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '👻 iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    'iceback-ᴍᴅ ᴍɪɴɪ ʙᴏᴛ'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'ICEBACK-MINI-main'}`);
});

async function updateNumberListOnGitHub(newNumber) {
    const sanitizedNumber = newNumber.replace(/[^0-9]/g, '');
    const pathOnGitHub = 'session/numbers.json';
    let numbers = [];

    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        numbers = JSON.parse(content);

        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Add ${sanitizedNumber} to numbers list`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64'),
                sha: data.sha
            });
            console.log(`✅ Added ${sanitizedNumber} to GitHub numbers.json`);
        }
    } catch (err) {
        if (err.status === 404) {
            numbers = [sanitizedNumber];
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Create numbers.json with ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64')
            });
            console.log(`📁 Created GitHub numbers.json with ${sanitizedNumber}`);
        } else {
            console.error('❌ Failed to update numbers.json:', err.message);
        }
    }
}

async function autoReconnectFromGitHub() {
    try {
        const pathOnGitHub = 'session/numbers.json';
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const numbers = JSON.parse(content);

        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from GitHub: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromGitHub error:', error.message);
    }
}

autoReconnectFromGitHub();

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/xking6/database/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}

module.exports = router;



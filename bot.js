require('dotenv').config();
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const fs = require('fs');

// ── CRASH PREVENTION ──────────────────────────────────────────────────────────
process.on('uncaughtException', err => console.error('⚠️ CRASH CAUGHT:', err.message));
process.on('unhandledRejection', err => console.error('⚠️ UNHANDLED:', err?.message || err));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
    ],
    partials: [Partials.Channel, Partials.Message]
});

// ── AUTO RECONNECT (discord.js handles reconnects automatically) ──────────────
client.on('shardDisconnect', () => {
    console.log('🔴 Disconnected — discord.js will auto-reconnect...');
});

const DB_FILE = './database.json';
let db = {};
let pendingBattles = {};       // { targetId: { challengerId, challengerName, defenderName } }
let activeBattles = {};        // { battleId: { p1, p2, p1Id, p2Id, turn, log, wildMode, wildPokemon } }
let wildPokemonState = {};     // { chatId: { pokemon, spawnTime } }
let messageCounters = {};      // { chatId: count }
let pendingCardTrades = {};    // { buyerId: { sellerId, cardIdx, cardData, price } }

// ── MOD NUMBERS (Discord User IDs — replace with real Discord IDs) ───────────
// ── OWNER / MOD IDs ──────────────────────────────────────────────────────────
// Tum dono ke Discord User IDs — ye log sab mod/owner commands use kar sakte hain
// Naya mod add karna ho toh iske array mein ek aur ID daal do
const MOD_NUMBERS = [
    '870273490568216648',   // Owner (tum)
    '1510151702475575337',  // Dost (mod)
];

// ══════════════════════════════════════════════════════════════════════════
// COMPATIBILITY SHIM — makes Discord's `message` object behave like
// whatsapp-web.js's `msg`/`chatObj`, so the ported game logic below
// needs minimal changes.
// ══════════════════════════════════════════════════════════════════════════
// Shim for whatsapp-web.js MessageMedia: returns {__media: true, url}
const MessageMedia = {
    fromUrl: async (url) => ({ __media: true, url }),
    fromFilePath: (path) => ({ __media: true, path })
};

function wrapMessage(message) {
    // FIX: this same message object is shared across multiple messageCreate
    // listeners. Wrapping it twice would re-derive senderId from an already
    // string-ified message.author (giving 'unknown') and double-wrap message.reply.
    // Make this function idempotent so calling it more than once is always safe.
    if (message.__wrapped) return message;
    message.__wrapped = true;

    const senderId = message.author?.id || 'unknown';  // FIX: safe guard against missing author

    message.author2 = senderId; // for code using msg.author || msg.from
    message.author = senderId;  // FIX: override Discord User object with plain string ID
    message.from = senderId;
    message.body = message.content;

    // msg.reply(text, {mentions:[...]}) -> Discord reply (mentions handled via <@id>)
    const originalReply = message.reply.bind(message);
    message.reply = (content, opts = {}) => {
        if (typeof content === 'string') {
            return originalReply({ content, allowedMentions: { parse: ['users'] } }).catch(() => {});
        }
        return originalReply(content).catch(() => {});
    };

    message.fromMe = false; // Discord bot messages are filtered out separately

    // mentionedIds: array of mentioned user IDs (WhatsApp style)
    message.mentionedIds = message.mentions?.users ? [...message.mentions.users.keys()] : [];  // FIX: safe guard

    // hasQuotedMsg / getQuotedMessage: based on Discord message replies
    message.hasQuotedMsg = !!message.reference;
    message.getQuotedMessage = async () => {
        if (!message.reference) return { author: null };
        try {
            const ref = await message.channel.messages.fetch(message.reference.messageId);
            return { author: ref.author.id };
        } catch (_) {
            return { author: null };
        }
    };

    message.getContact = async () => ({ id: { _serialized: senderId } });

    // msg.getChat() -> returns an object with id._serialized, isGroup, sendMessage
    message.getChat = async () => {
        let participants = [];
        if (message.guild) {
            try {
                const members = await message.guild.members.fetch();
                // FIX: members is a Discord Collection, must use .values() before .map()
                participants = [...members.values()].map(m => ({
                    id: { _serialized: m.id },
                    isAdmin: m.permissions.has('Administrator') || m.permissions.has('ModerateMembers'),
                    isSuperAdmin: m.permissions.has('Administrator')
                }));
            } catch (_) {}
        }
        return {
            id: { _serialized: message.channel.id },
            isGroup: !!message.guild,
            participants,
            removeParticipants: async (ids) => {
                if (!message.guild) return;
                for (const id of ids) {
                    const member = await message.guild.members.fetch(id.split('@')[0] || id).catch(() => null);
                    if (member) await member.kick().catch(() => {});
                }
            },
            sendMessage: (content, opts = {}) => {
            // Image/media + caption (MessageMedia shim object)
            if (content && content.__media) {
                const payload = { content: opts.caption || '', allowedMentions: { parse: ['users'] } };
                if (content.url) payload.files = [new AttachmentBuilder(content.url, { name: 'image.png' })];
                else if (content.path) payload.files = [new AttachmentBuilder(content.path)];
                return message.channel.send(payload).catch(() => {});
            }
            if (typeof content === 'string') {
                return message.channel.send({ content, allowedMentions: { parse: ['users'] } }).catch(() => {});
            }
                return message.channel.send(content).catch(() => {});
            }
        };
    };

    return message;
}

// Convert "@123456789" (WhatsApp style) mentions to Discord "<@123456789>"
function toDiscordMention(id) {
    return `<@${id}>`;
}

// Discord-based "is mod/admin" check
async function checkIsMod(msg) {
    try {
        // msg.author is a string ID after wrapMessage; before wrapMessage it's a User object
        const authorId = typeof msg.author === 'string' ? msg.author : (msg.author?.id || '');
        if (!authorId) return false;

        // 1. Hardcoded owner IDs always pass
        if (MOD_NUMBERS.includes(authorId)) return true;

        // 2. DMs — treat as allowed
        if (!msg.guild) return true;

        // 3. Check Discord server permissions directly from the original message's guild
        //    msg.guild is still intact — wrapMessage doesn't remove it
        const member = await msg.guild.members.fetch(authorId).catch(() => null);
        if (!member) return false;

        return member.permissions.has('Administrator') ||
               member.permissions.has('ModerateMembers') ||
               member.permissions.has('ManageGuild') ||
               member.permissions.has('KickMembers');
    } catch (e) {
        console.error('checkIsMod error:', e.message);
        // Fallback: only hardcoded owners
        const authorId = typeof msg.author === 'string' ? msg.author : (msg.author?.id || '');
        return MOD_NUMBERS.includes(authorId);
    }
}



// ── POKÉBALL SHOP ─────────────────────────────────────────────────────────────
const POKEBALL_SHOP = {
    pokeball:    { name: 'Pokéball',       price: 500,    catchBonus: 0,   emoji: '🔴', desc: 'Standard catch tool' },
    greatball:   { name: 'Great Ball',     price: 2000,   catchBonus: 15,  emoji: '🔵', desc: '+15% catch rate' },
    ultraball:   { name: 'Ultra Ball',     price: 5000,   catchBonus: 30,  emoji: '⚫', desc: '+30% catch rate' },
    masterball:  { name: 'Master Ball',    price: 500000, catchBonus: 100, emoji: '🟣', desc: '100% guaranteed catch!' },
    heavyball:   { name: 'Heavy Ball',     price: 8000,   catchBonus: 20,  emoji: '⚙️', desc: 'Best vs large Pokémon' },
    lureball:    { name: 'Lure Ball',      price: 3000,   catchBonus: 25,  emoji: '🎣', desc: 'Extra effective on fish Pokémon' },
};

// ── FOOD SHOP ─────────────────────────────────────────────────────────────────
const FOOD_SHOP = {
    chicken:    { name: 'Roasted Chicken',   price: 400,      heal: 25,  atkBoost: 2,  energy: 25,   emoji: '🍗',   desc: 'Restores +25 HP & +2 ATK', isAlcohol: false, isToxic: false },
    milkshake:  { name: 'Thick Milkshake',   price: 700,      heal: 45,  atkBoost: 3,  energy: 45,   emoji: '🥤',   desc: 'Restores +45 HP & +3 ATK', isAlcohol: false, isToxic: false },
    coke:       { name: 'Chilled Coke',      price: 100,      heal: 65,  atkBoost: 4,  energy: 65,   emoji: '🥤',   desc: 'Restores +65 HP & +4 ATK', isAlcohol: false, isToxic: false },
    protein:    { name: 'Protein Bar',       price: 2500,     heal: 100, atkBoost: 8,  energy: 100,  emoji: '🍫',   desc: 'Fully restores HP & +8 ATK', isAlcohol: false, isToxic: false },
    mystery:    { name: 'Mystery Drink',     price: 5000,     heal: 100, atkBoost: 10, energy: 100,  emoji: '🧪',   desc: 'Full heal + +10 ATK + +20 XP!', isAlcohol: false, isToxic: false },
    mrbeast:    { name: 'MrBeast Chocolate', price: 10000000, heal: 999, atkBoost: 25, energy: 999,  emoji: '🍫✨', desc: 'PERMANENT +50 Max HP & +25 ATK! (Max 5/day per Pokémon)', isAlcohol: false, isToxic: false },
    pizza:      { name: 'Mega Pizza',        price: 1200,     heal: 80,  atkBoost: 5,  energy: 80,   emoji: '🍕',   desc: 'Restores +80 HP & +5 ATK — cheesy goodness', isAlcohol: false, isToxic: false },
    sushi:      { name: 'Premium Sushi',     price: 3000,     heal: 90,  atkBoost: 6,  energy: 90,   emoji: '🍣',   desc: 'Restores +90 HP + +6 ATK + +10 XP boost', isAlcohol: false, isToxic: false, xpBonus: 10 },
    energy:     { name: 'Energy Drink',      price: 800,      heal: 50,  atkBoost: 5,  energy: 50,   emoji: '⚡',   desc: 'Restores +50 HP + +5 ATK for next battle', isAlcohol: false, isToxic: false, atkBuff: 5 },
    // ── Alcohol & Funny items ──
    rum:        { name: 'Dark Rum 🍾',       price: 1500,     heal: 40,  atkBoost: 0,  energy: 40,   emoji: '🍾',   desc: '1-3 uses: +40 HP & +10 ATK buff. After 3: TOXIC for 10 mins!', isAlcohol: true, atkBuff: 10 },
    whiskey:    { name: 'Old Whiskey 🥃',    price: 2000,     heal: 50,  atkBoost: 0,  energy: 50,   emoji: '🥃',   desc: '1-3 uses: +50 HP & +15 ATK buff. After 3: TOXIC for 12 mins!', isAlcohol: true, atkBuff: 15 },
    cigar:      { name: 'Premium Cigar 🚬',  price: 500,      heal: 20,  atkBoost: 0,  energy: 20,   emoji: '🚬',   desc: '1-3 uses: +20 HP & +5 ATK swagger. After 3: TOXIC for 10 mins!', isAlcohol: true, atkBuff: 5 },
    cigarette:  { name: 'Cigarette Pack 🚬', price: 200,      heal: 10,  atkBoost: 0,  energy: 10,   emoji: '🚬',   desc: '1-3 uses: +10 HP & +3 ATK. After 3: TOXIC for 15 mins!', isAlcohol: true, atkBuff: 3 },
    beer:       { name: 'Cold Beer 🍺',      price: 600,      heal: 30,  atkBoost: 0,  energy: 30,   emoji: '🍺',   desc: '1-3 uses: +30 HP & +8 ATK. After 3: TOXIC for 10 mins!', isAlcohol: true, atkBuff: 8 },
};

// ── POKÉMON MOVES ─────────────────────────────────────────────────────────────
const POKEMON_MOVES = {
    pikachu:    [
        { name: 'Thunderbolt',   damage: [45, 65], emoji: '⚡', special: false },
        { name: 'Thunder',       damage: [60, 90], emoji: '🌩️', special: true  },
        { name: 'Quick Attack',  damage: [20, 35], emoji: '💨', special: false },
        { name: 'Volt Tackle',   damage: [80, 110],emoji: '⚡💥',special: true  },
    ],
    bulbasaur:  [
        { name: 'Vine Whip',     damage: [35, 50], emoji: '🌿', special: false },
        { name: 'Solar Beam',    damage: [65, 90], emoji: '☀️', special: true  },
        { name: 'Razor Leaf',    damage: [40, 60], emoji: '🍃', special: false },
        { name: 'Poison Powder', damage: [25, 40], emoji: '☠️', special: false },
    ],
    charmander: [
        { name: 'Ember',         damage: [35, 55], emoji: '🔥', special: false },
        { name: 'Fire Spin',     damage: [55, 80], emoji: '🌀🔥',special: true  },
        { name: 'Scratch',       damage: [20, 35], emoji: '✋', special: false },
        { name: 'Flamethrower',  damage: [60, 85], emoji: '🔥💨',special: true  },
    ],
    squirtle:   [
        { name: 'Water Gun',     damage: [35, 50], emoji: '💧', special: false },
        { name: 'Aqua Tail',     damage: [65, 90], emoji: '🌊💙',special: true  },
        { name: 'Withdraw',      damage: [20, 30], emoji: '🐢', special: false },
        { name: 'Bubble Beam',   damage: [45, 65], emoji: '🫧', special: false },
    ],
    charizard:  [
        { name: 'Wing Attack',   damage: [65, 88], emoji: '🦅🔥',special: false },
        { name: 'Fire Blast',    damage: [90, 130],emoji: '💥🔥',special: true  },
        { name: 'Dragon Claw',   damage: [75, 100],emoji: '🐉', special: false },
        { name: 'Inferno',       damage: [100,140],emoji: '☄️', special: true  },
    ],
    blastoise:  [
        { name: 'Hydro Pump',    damage: [75, 100],emoji: '🌊', special: true  },
        { name: 'Water Cannon',  damage: [85, 115],emoji: '💦🔵',special: true  },
        { name: 'Skull Bash',    damage: [60, 80], emoji: '💀', special: false },
        { name: 'Ice Beam',      damage: [65, 90], emoji: '🧊', special: false },
    ],
    venusaur:   [
        { name: 'Petal Blizzard',damage: [80, 110],emoji: '🌸💨',special: true  },
        { name: 'Petal Dance',   damage: [70, 95], emoji: '🌺', special: false },
        { name: 'Frenzy Plant',  damage: [90, 125],emoji: '🌱💥',special: true  },
        { name: 'Sludge Bomb',   damage: [65, 85], emoji: '☠️💚',special: false },
    ],
    greninja:   [
        { name: 'Water Shuriken',damage: [80, 110],emoji: '🥷💧',special: true  },
        { name: 'Night Slash',   damage: [70, 95], emoji: '🌑✂️',special: false },
        { name: 'Mat Block',     damage: [55, 75], emoji: '🥷🛡️',special: false },
        { name: 'Hydro Vortex',  damage: [100,135],emoji: '🌀🌊',special: true  },
    ],
    gengar:     [
        { name: 'Shadow Ball',   damage: [80, 110],emoji: '👻🌑',special: true  },
        { name: 'Dream Eater',   damage: [90, 120],emoji: '💤😈',special: true  },
        { name: 'Lick',          damage: [55, 75], emoji: '👅👻',special: false },
        { name: 'Curse',         damage: [70, 95], emoji: '🪄👻',special: false },
    ],
    gyarados:   [
        { name: 'Hyper Beam',    damage: [100,140],emoji: '💥🔱',special: true  },
        { name: 'Dragon Rage',   damage: [80, 110],emoji: '🐉💢',special: false },
        { name: 'Aqua Tail',     damage: [75, 100],emoji: '🌊🐟',special: false },
        { name: 'Crunch',        damage: [70, 95], emoji: '🦷💥',special: false },
    ],
    garchomp:   [
        { name: 'Dragon Rush',   damage: [90, 125],emoji: '🦈🌪️',special: false },
        { name: 'Earth Power',   damage: [95, 130],emoji: '🌍💥',special: true  },
        { name: 'Sand Tomb',     damage: [65, 85], emoji: '🏜️🌀',special: false },
        { name: 'Outrage',       damage: [110,150],emoji: '💢🐉',special: true  },
    ],
    lucario:    [
        { name: 'Aura Sphere',   damage: [95, 130],emoji: '✨🔵',special: true  },
        { name: 'Close Combat',  damage: [100,135],emoji: '👊💥',special: false },
        { name: 'Bone Rush',     damage: [75, 100],emoji: '🦴⚡',special: false },
        { name: 'Steel Cannon',  damage: [85, 115],emoji: '🔩💡',special: true  },
    ],
    mew:        [
        { name: 'Mew Beam',      damage: [90, 120],emoji: '🌀✨',special: true  },
        { name: 'Ancient Power', damage: [80, 110],emoji: '🪨💫',special: false },
        { name: 'Metronome',     damage: [70, 130],emoji: '🎵🔀',special: true  },
        { name: 'Transform',     damage: [75, 110],emoji: '🌟🔄',special: true  },
    ],
    darkrai:    [
        { name: 'Dark Void',     damage: [100,140],emoji: '🌑🕳️',special: true  },
        { name: 'Phantom Force', damage: [85, 115],emoji: '👻💜',special: false },
        { name: 'Nightmare',     damage: [90, 125],emoji: '💤😱',special: true  },
        { name: 'Feint Attack',  damage: [70, 95], emoji: '🌚⚔️',special: false },
    ],
    mewtwo:     [
        { name: 'Psystrike',     damage: [110,150],emoji: '🌌💜',special: true  },
        { name: 'Psyblast',      damage: [100,135],emoji: '🌀💥',special: true  },
        { name: 'Barrier Break', damage: [90, 120],emoji: '🧱💔',special: false },
        { name: 'Genesis Nova',  damage: [120,160],emoji: '🌌⚡',special: true  },
    ],
    rayquaza:   [
        { name: 'Dragon Ascent', damage: [120,165],emoji: '🟢🐉',special: true  },
        { name: 'Sky Attack',    damage: [105,145],emoji: '☁️💥',special: true  },
        { name: 'Outrage',       damage: [105,140],emoji: '💢🌪️',special: false },
        { name: 'Air Lock Slam', damage: [100,135],emoji: '🌪️⚡',special: false },
    ],
    lugia:      [
        { name: 'Aeroblast',     damage: [115,155],emoji: '🦅💨',special: true  },
        { name: 'Gust of Doom',  damage: [90, 120],emoji: '🌬️🌊',special: false },
        { name: 'Extrasensory',  damage: [95, 130],emoji: '🌀🔵',special: true  },
        { name: 'Sky Drop',      damage: [80, 110],emoji: '🌤️⬇️',special: false },
    ],
    arceus:     [
        { name: 'Judgement',     damage: [130,175],emoji: '👑⚡',special: true  },
        { name: 'Hyper Voice',   damage: [110,150],emoji: '📣💫',special: false },
        { name: 'Earth Power',   damage: [115,155],emoji: '🌍⚡',special: true  },
        { name: 'Seraph Strike', damage: [100,140],emoji: '🌌🌟',special: false },
    ],
    // New Pokémon moves
    rattata:    [
        { name: 'Bite',          damage: [20, 35], emoji: '🦷',  special: false },
        { name: 'Hyper Fang',    damage: [35, 50], emoji: '😬',  special: false },
        { name: 'Quick Attack',  damage: [15, 28], emoji: '💨',  special: false },
        { name: 'Super Fang',    damage: [30, 45], emoji: '⚡🦷', special: true  },
    ],
    pidgey:     [
        { name: 'Gust',          damage: [18, 30], emoji: '🌬️', special: false },
        { name: 'Wing Attack',   damage: [25, 40], emoji: '🦅',  special: false },
        { name: 'Whirlwind',     damage: [20, 35], emoji: '🌀',  special: false },
        { name: 'Aerial Ace',    damage: [30, 45], emoji: '✈️✨', special: true  },
    ],
    meowth:     [
        { name: 'Scratch',       damage: [18, 30], emoji: '✋',  special: false },
        { name: 'Pay Day',       damage: [25, 40], emoji: '🪙💥', special: false },
        { name: 'Fury Swipes',   damage: [20, 38], emoji: '💅💥', special: false },
        { name: 'Night Slash',   damage: [32, 50], emoji: '🌑✂️', special: true  },
    ],
    psyduck:    [
        { name: 'Water Sport',   damage: [22, 36], emoji: '💧',  special: false },
        { name: 'Confusion',     damage: [30, 46], emoji: '🌀🦆', special: true  },
        { name: 'Disable',       damage: [18, 30], emoji: '😵',  special: false },
        { name: 'Psychic Wave',  damage: [42, 60], emoji: '🌊🌀', special: true  },
    ],
    growlithe:  [
        { name: 'Bite',          damage: [28, 42], emoji: '🦷🔥', special: false },
        { name: 'Flame Wheel',   damage: [38, 55], emoji: '🔥🌀', special: false },
        { name: 'Agility',       damage: [22, 36], emoji: '💨🐕', special: false },
        { name: 'Flare Blitz',   damage: [55, 78], emoji: '🔥💥', special: true  },
    ],
    abra:       [
        { name: 'Teleport',      damage: [15, 25], emoji: '🔮✨', special: false },
        { name: 'Psybeam',       damage: [28, 42], emoji: '🌈🌀', special: true  },
        { name: 'Hidden Power',  damage: [22, 36], emoji: '⭐',   special: false },
        { name: 'Future Sight',  damage: [45, 65], emoji: '👁️🌀', special: true  },
    ],
    machop:     [
        { name: 'Karate Chop',   damage: [32, 48], emoji: '🥋✋', special: false },
        { name: 'Low Kick',      damage: [26, 40], emoji: '🦵',   special: false },
        { name: 'Submission',    damage: [40, 58], emoji: '🤼',   special: false },
        { name: 'Seismic Toss',  damage: [50, 72], emoji: '🌍🤜', special: true  },
    ],
    haunter:    [
        { name: 'Lick',          damage: [25, 38], emoji: '👅💜', special: false },
        { name: 'Spite',         damage: [20, 32], emoji: '😤👻', special: false },
        { name: 'Sucker Punch',  damage: [35, 52], emoji: '👊🌑', special: false },
        { name: 'Shadow Punch',  damage: [48, 68], emoji: '🌑👊', special: true  },
    ],
    scyther:    [
        { name: 'Slash',         damage: [45, 65], emoji: '⚔️',  special: false },
        { name: 'Wing Attack',   damage: [38, 55], emoji: '🦅⚔️', special: false },
        { name: 'X-Scissor',     damage: [55, 78], emoji: '✂️✂️', special: false },
        { name: 'Fury Cutter',   damage: [65, 92], emoji: '🔪💥', special: true  },
    ],
    eevee:      [
        { name: 'Tackle',        damage: [24, 38], emoji: '💪🦊', special: false },
        { name: 'Swift',         damage: [32, 48], emoji: '⭐🌟', special: false },
        { name: 'Bite',          damage: [28, 44], emoji: '🦷🦊', special: false },
        { name: 'Last Resort',   damage: [50, 72], emoji: '🦊💥', special: true  },
    ],
    snorlax:    [
        { name: 'Body Slam',     damage: [65, 90], emoji: '😴💥', special: false },
        { name: 'Rest',          damage: [40, 60], emoji: '💤❤️', special: false },
        { name: 'Hyper Beam',    damage: [85, 118],emoji: '😴💥🔥',special: true  },
        { name: 'Heavy Slam',    damage: [75, 105],emoji: '⚙️💥', special: true  },
    ],
    dragonite:  [
        { name: 'Dragon Rush',   damage: [70, 98], emoji: '🐲💨', special: false },
        { name: 'Thunder Punch', damage: [62, 88], emoji: '⚡👊', special: false },
        { name: 'Fire Punch',    damage: [65, 92], emoji: '🔥👊', special: false },
        { name: 'Draco Meteor',  damage: [95, 132],emoji: '🌠🐲', special: true  },
    ],
    alakazam:   [
        { name: 'Psybeam',       damage: [42, 62], emoji: '🌈💜', special: false },
        { name: 'Kinesis',       damage: [35, 55], emoji: '🥄💫', special: false },
        { name: 'Telekinesis',   damage: [55, 78], emoji: '🌀🥄', special: false },
        { name: 'Psycho Cut',    damage: [68, 95], emoji: '🔮✂️', special: true  },
    ],
    articuno:   [
        { name: 'Ice Shard',     damage: [50, 72], emoji: '❄️🧊', special: false },
        { name: 'Freeze Dry',    damage: [65, 90], emoji: '🧊💨', special: false },
        { name: 'Blizzard',      damage: [80, 115],emoji: '❄️🌪️', special: true  },
        { name: 'Sheer Cold',    damage: [90, 128],emoji: '🌨️💀', special: true  },
    ],
    zapdos:     [
        { name: 'Thunder Shock', damage: [50, 72], emoji: '⚡🐦', special: false },
        { name: 'Drill Peck',    damage: [62, 88], emoji: '🔩🐦', special: false },
        { name: 'Discharge',     damage: [75, 105],emoji: '⚡💥', special: true  },
        { name: 'Zap Cannon',    damage: [92, 128],emoji: '⚡🔫', special: true  },
    ],
    moltres:    [
        { name: 'Fire Spin',     damage: [52, 75], emoji: '🔥🌀', special: false },
        { name: 'Sky Attack',    damage: [65, 92], emoji: '🦅🔥', special: false },
        { name: 'Flame Burst',   damage: [78, 108],emoji: '💥🔥', special: true  },
        { name: 'Inferno Wing',  damage: [95, 132],emoji: '☄️🦅', special: true  },
    ],
    // Extra new Pokémon
    totodile:   [
        { name: 'Water Gun',     damage: [30, 46], emoji: '💧🐊', special: false },
        { name: 'Bite',          damage: [28, 44], emoji: '🦷🐊', special: false },
        { name: 'Aqua Jet',      damage: [40, 58], emoji: '💦⚡', special: false },
        { name: 'Crunch',        damage: [55, 78], emoji: '🐊💥', special: true  },
    ],
    cyndaquil:  [
        { name: 'Ember',         damage: [28, 44], emoji: '🔥🦔', special: false },
        { name: 'Smokescreen',   damage: [22, 36], emoji: '💨🌫️', special: false },
        { name: 'Flame Charge',  damage: [42, 62], emoji: '🔥💨', special: false },
        { name: 'Eruption',      damage: [65, 92], emoji: '🌋🔥', special: true  },
    ],
    chikorita:  [
        { name: 'Razor Leaf',    damage: [28, 44], emoji: '🍃✂️', special: false },
        { name: 'Sweet Scent',   damage: [20, 32], emoji: '🌸🌿', special: false },
        { name: 'Magical Leaf',  damage: [40, 58], emoji: '🍀✨', special: false },
        { name: 'Leaf Storm',    damage: [62, 88], emoji: '🌪️🍃', special: true  },
    ],
    umbreon:    [
        { name: 'Dark Pulse',    damage: [55, 78], emoji: '🌑💜', special: false },
        { name: 'Moonblast',     damage: [68, 95], emoji: '🌙✨', special: true  },
        { name: 'Mean Look',     damage: [42, 60], emoji: '👁️🌑', special: false },
        { name: 'Foul Play',     damage: [75, 105],emoji: '😈🌑', special: true  },
    ],
    espeon:     [
        { name: 'Psybeam',       damage: [52, 75], emoji: '🌈💜', special: false },
        { name: 'Morning Sun',   damage: [45, 65], emoji: '☀️🌸', special: false },
        { name: 'Psyshock',      damage: [68, 95], emoji: '🌀💥', special: true  },
        { name: 'Future Sight',  damage: [82, 115],emoji: '👁️💜', special: true  },
    ],
    ampharos:   [
        { name: 'Thundershock',  damage: [48, 68], emoji: '⚡🐑', special: false },
        { name: 'Thunder Punch', damage: [60, 85], emoji: '⚡👊', special: false },
        { name: 'Signal Beam',   damage: [72, 100],emoji: '📡⚡', special: true  },
        { name: 'Zap Canon',     damage: [88, 122],emoji: '⚡💥', special: true  },
    ],
    tyranitar:  [
        { name: 'Rock Slide',    damage: [65, 90], emoji: '🪨💥', special: false },
        { name: 'Crunch',        damage: [72, 100],emoji: '🦷💢', special: false },
        { name: 'Dark Pulse',    damage: [78, 108],emoji: '🌑🦖', special: true  },
        { name: 'Stone Edge',    damage: [95, 132],emoji: '💎🪨', special: true  },
    ],
    blaziken:   [
        { name: 'Blaze Kick',    damage: [68, 95], emoji: '🔥🦵', special: false },
        { name: 'Sky Uppercut',  damage: [62, 88], emoji: '👊☁️', special: false },
        { name: 'High Jump Kick',damage: [80, 112],emoji: '🦵💥', special: false },
        { name: 'Blast Burn',    damage: [98, 138],emoji: '🔥💥', special: true  },
    ],
    swampert:   [
        { name: 'Mud Shot',      damage: [50, 72], emoji: '🌊🤎', special: false },
        { name: 'Hammer Arm',    damage: [65, 92], emoji: '💪🌊', special: false },
        { name: 'Muddy Water',   damage: [75, 105],emoji: '🌊💦', special: true  },
        { name: 'Hydro Cannon',  damage: [95, 132],emoji: '💧💥', special: true  },
    ],
    sceptile:   [
        { name: 'Leaf Blade',    damage: [62, 88], emoji: '🍃⚔️', special: false },
        { name: 'Detect',        damage: [40, 58], emoji: '👁️🌿', special: false },
        { name: 'Dragon Claw',   damage: [70, 98], emoji: '🐉🌿', special: false },
        { name: 'Frenzy Plant',  damage: [95, 132],emoji: '🌱💥', special: true  },
    ],
    metagross:  [
        { name: 'Meteor Mash',   damage: [78, 108],emoji: '🪐💥', special: false },
        { name: 'Zen Headbutt',  damage: [68, 95], emoji: '🔩🌀', special: false },
        { name: 'Bullet Punch',  damage: [60, 85], emoji: '🔩👊', special: false },
        { name: 'Psychic Fang',  damage: [92, 128],emoji: '🌀🦷', special: true  },
    ],
    latios:     [
        { name: 'Luster Purge',  damage: [82, 115],emoji: '💙✨', special: true  },
        { name: 'Dragon Pulse',  damage: [72, 100],emoji: '🐉💙', special: false },
        { name: 'Psychic Boost', damage: [78, 108],emoji: '🌀💙', special: true  },
        { name: 'Mist Ball',     damage: [88, 122],emoji: '🌫️💙', special: true  },
    ],
    latias:     [
        { name: 'Mist Ball',     damage: [80, 112],emoji: '🌫️❤️', special: true  },
        { name: 'Charm',         damage: [55, 78], emoji: '💕🐉', special: false },
        { name: 'Draco Meteor',  damage: [88, 122],emoji: '🌠❤️', special: true  },
        { name: 'Dragon Breath', damage: [68, 95], emoji: '🐉❤️', special: false },
    ],
    giratina:   [
        { name: 'Shadow Force',  damage: [102,142],emoji: '👻🌑', special: true  },
        { name: 'Aura Sphere',   damage: [85, 118],emoji: '✨🔮', special: true  },
        { name: 'Dragon Pulse',  damage: [78, 108],emoji: '🐉🌑', special: false },
        { name: 'Ancient Power', damage: [72, 100],emoji: '🪨⚫', special: false },
    ],
    dialga:     [
        { name: 'Roar of Time',  damage: [108,150],emoji: '⏱️🐉', special: true  },
        { name: 'Metal Burst',   damage: [88, 122],emoji: '🔩💥', special: true  },
        { name: 'Dragon Claw',   damage: [78, 108],emoji: '🐉⏰', special: false },
        { name: 'Flash Cannon',  damage: [82, 115],emoji: '💡🔷', special: true  },
    ],
    palkia:     [
        { name: 'Spacial Rend',  damage: [108,148],emoji: '🌌🔱', special: true  },
        { name: 'Hydro Pump',    damage: [88, 120],emoji: '🌊🔱', special: true  },
        { name: 'Dragon Pulse',  damage: [80, 112],emoji: '🐉🌌', special: false },
        { name: 'Aqua Ring',     damage: [72, 100],emoji: '💧🔱', special: false },
    ],
    reshiram:   [
        { name: 'Blue Flare',    damage: [112,155],emoji: '🔥💙', special: true  },
        { name: 'Fusion Flare',  damage: [98, 138],emoji: '🔥⚪', special: true  },
        { name: 'Dragon Breath', damage: [80, 112],emoji: '🐉🔥', special: false },
        { name: 'Hyper Voice',   damage: [75, 105],emoji: '📣🔥', special: false },
    ],
    zekrom:     [
        { name: 'Bolt Strike',   damage: [112,155],emoji: '⚡🔱', special: true  },
        { name: 'Fusion Bolt',   damage: [98, 138],emoji: '⚡⚫', special: true  },
        { name: 'Dragon Claw',   damage: [80, 112],emoji: '🐉⚡', special: false },
        { name: 'Outrage',       damage: [88, 122],emoji: '💢⚡', special: false },
    ],
    kyurem:     [
        { name: 'Ice Burn',      damage: [108,148],emoji: '🔥🧊', special: true  },
        { name: 'Freeze Shock',  damage: [102,142],emoji: '❄️⚡', special: true  },
        { name: 'Dragon Pulse',  damage: [82, 115],emoji: '🐉❄️', special: false },
        { name: 'Glaciate',      damage: [88, 122],emoji: '🧊💨', special: true  },
    ],
    xerneas:    [
        { name: 'Geomancy',      damage: [95, 132],emoji: '🌺🌟', special: true  },
        { name: 'Moonblast',     damage: [88, 122],emoji: '🌙✨', special: true  },
        { name: 'Fairy Wind',    damage: [72, 100],emoji: '🌸💨', special: false },
        { name: 'Close Combat',  damage: [80, 112],emoji: '🦌💥', special: false },
    ],
    yveltal:    [
        { name: 'Oblivion Wing', damage: [108,148],emoji: '🌑🦅', special: true  },
        { name: 'Dark Pulse',    damage: [85, 118],emoji: '🌑💜', special: false },
        { name: 'Sky Attack',    damage: [80, 112],emoji: '☁️⚫', special: false },
        { name: 'Death Wing',    damage: [98, 138],emoji: '💀🦅', special: true  },
    ],
    zygarde:    [
        { name: 'Land\'s Wrath', damage: [102,142],emoji: '🌍🐍', special: true  },
        { name: 'Thousand Arrows',damage: [92,128],emoji: '🏹🌿', special: true  },
        { name: 'Dragon Pulse',  damage: [78, 108],emoji: '🐉🌿', special: false },
        { name: 'Core Enforcer', damage: [98, 138],emoji: '🌟🐍', special: true  },
    ],
    solgaleo:   [
        { name: 'Sunsteel Strike',damage: [112,155],emoji: '☀️🦁', special: true  },
        { name: 'Zen Headbutt',  damage: [85, 118],emoji: '🌀🦁', special: false },
        { name: 'Solar Blade',   damage: [98, 138],emoji: '☀️⚔️', special: true  },
        { name: 'Full Metal Body',damage: [80, 112],emoji: '🔩🦁', special: false },
    ],
    lunala:     [
        { name: 'Moongeist Beam',damage: [112,155],emoji: '🌙🦇', special: true  },
        { name: 'Shadow Ray',    damage: [98, 138],emoji: '👻🌙', special: true  },
        { name: 'Moonblast',     damage: [85, 118],emoji: '🌙✨', special: false },
        { name: 'Phantom Force', damage: [80, 112],emoji: '👻💜', special: false },
    ],
    necrozma:   [
        { name: 'Prismatic Laser',damage: [118,162],emoji: '🌈🔱', special: true  },
        { name: 'Photon Geyser', damage: [105,145],emoji: '💡💥', special: true  },
        { name: 'Power Gem',     damage: [88, 122],emoji: '💎⚡', special: false },
        { name: 'Searing Light', damage: [95, 132],emoji: '☀️🔱', special: true  },
    ],
    zacian:     [
        { name: 'Behemoth Blade',damage: [118,162],emoji: '⚔️🌸', special: true  },
        { name: 'Play Rough',    damage: [88, 122],emoji: '🐾💕', special: false },
        { name: 'Sacred Sword',  damage: [98, 138],emoji: '⚔️✨', special: true  },
        { name: 'Iron Head',     damage: [82, 115],emoji: '🔩👑', special: false },
    ],
    zamazenta:  [
        { name: 'Behemoth Bash', damage: [118,162],emoji: '🛡️💙', special: true  },
        { name: 'Close Combat',  damage: [88, 122],emoji: '👊🛡️', special: false },
        { name: 'Sacred Sword',  damage: [95, 132],emoji: '⚔️🔵', special: true  },
        { name: 'Body Press',    damage: [82, 115],emoji: '💪🔵', special: false },
    ],
};

// Default moves for wild/unconfigured Pokémon
const DEFAULT_MOVES = [
    { name: 'Tackle',    damage: [15, 30], emoji: '💪', special: false },
    { name: 'Scratch',   damage: [20, 35], emoji: '✋', special: false },
    { name: 'Growl',     damage: [10, 20], emoji: '😾', special: false },
    { name: 'Quick Hit', damage: [25, 40], emoji: '💨', special: false },
];

function getMovesForPokemon(pokeName) {
    return POKEMON_MOVES[pokeName.toLowerCase()] || DEFAULT_MOVES;
}

// ── WILD POKÉMON POOL ─────────────────────────────────────────────────────────
const WILD_POKEMON_POOL = [
    // ── WEAK ──
    { name: 'Rattata',    hp: 30,  atk: 56,  emoji: '🐭', dexId: 19,  rarity: 'Weak', category: 'Normal'    },
    { name: 'Pidgey',     hp: 40,  atk: 45,  emoji: '🐦', dexId: 16,  rarity: 'Weak', category: 'Normal'    },
    { name: 'Meowth',     hp: 40,  atk: 45,  emoji: '🐱', dexId: 52,  rarity: 'Weak', category: 'Normal'    },
    { name: 'Caterpie',   hp: 28,  atk: 30,  emoji: '🐛', dexId: 10,  rarity: 'Weak', category: 'Normal'    },
    { name: 'Weedle',     hp: 28,  atk: 35,  emoji: '🐝', dexId: 13,  rarity: 'Weak', category: 'Normal'    },
    { name: 'Magikarp',   hp: 20,  atk: 10,  emoji: '🐟', dexId: 129, rarity: 'Weak', category: 'Normal'    },
    { name: 'Zubat',      hp: 35,  atk: 40,  emoji: '🦇', dexId: 41,  rarity: 'Weak', category: 'Normal'    },
    { name: 'Spearow',    hp: 38,  atk: 42,  emoji: '🦅', dexId: 21,  rarity: 'Weak', category: 'Normal'    },
    // ── COMMON ──
    { name: 'Psyduck',    hp: 50,  atk: 52,  emoji: '🦆', dexId: 54,  rarity: 'Common', category: 'Normal'  },
    { name: 'Growlithe',  hp: 55,  atk: 70,  emoji: '🐕', dexId: 58,  rarity: 'Common', category: 'Normal'  },
    { name: 'Abra',       hp: 25,  atk: 20,  emoji: '🔮', dexId: 63,  rarity: 'Common', category: 'Normal'  },
    { name: 'Machop',     hp: 70,  atk: 80,  emoji: '💪', dexId: 66,  rarity: 'Common', category: 'Normal'  },
    { name: 'Totodile',   hp: 50,  atk: 65,  emoji: '🐊', dexId: 158, rarity: 'Common', category: 'Normal'  },
    { name: 'Cyndaquil',  hp: 45,  atk: 60,  emoji: '🔥🦔',dexId: 155,rarity: 'Common', category: 'Normal'  },
    { name: 'Chikorita',  hp: 45,  atk: 49,  emoji: '🌿', dexId: 152, rarity: 'Common', category: 'Normal'  },
    { name: 'Sudowoodo',  hp: 70,  atk: 65,  emoji: '🪨🌳',dexId: 185,rarity: 'Common', category: 'Normal'  },
    { name: 'Marill',     hp: 70,  atk: 20,  emoji: '🐭💧',dexId: 183,rarity: 'Common', category: 'Normal'  },
    { name: 'Aipom',      hp: 55,  atk: 70,  emoji: '🐒', dexId: 190, rarity: 'Common', category: 'Normal'  },
    { name: 'Misdreavus', hp: 60,  atk: 85,  emoji: '👻💜',dexId: 200,rarity: 'Common', category: 'Ghost'   },
    { name: 'Snubbull',   hp: 60,  atk: 80,  emoji: '🐶💕',dexId: 209,rarity: 'Common', category: 'Normal'  },
    // ── RARE ──
    { name: 'Haunter',    hp: 45,  atk: 50,  emoji: '👻', dexId: 93,  rarity: 'Rare', category: 'Ghost'     },
    { name: 'Scyther',    hp: 70,  atk: 110, emoji: '🦗', dexId: 123, rarity: 'Rare', category: 'Normal'    },
    { name: 'Eevee',      hp: 55,  atk: 55,  emoji: '🦊', dexId: 133, rarity: 'Rare', category: 'Normal'    },
    { name: 'Umbreon',    hp: 95,  atk: 65,  emoji: '🌑🦊',dexId: 197,rarity: 'Rare', category: 'Dark'      },
    { name: 'Espeon',     hp: 65,  atk: 90,  emoji: '🌸🦊',dexId: 196,rarity: 'Rare', category: 'Psychic'   },
    { name: 'Ampharos',   hp: 90,  atk: 85,  emoji: '⚡🐑',dexId: 181,rarity: 'Rare', category: 'Electric'  },
    { name: 'Heracross',  hp: 80,  atk: 125, emoji: '🦏🐛',dexId: 214,rarity: 'Rare', category: 'Fighting'  },
    { name: 'Sneasel',    hp: 55,  atk: 95,  emoji: '🌑❄️',dexId: 215,rarity: 'Rare', category: 'Dark'      },
    { name: 'Porygon2',   hp: 85,  atk: 80,  emoji: '💻🌀',dexId: 233,rarity: 'Rare', category: 'Normal'    },
    { name: 'Larvitar',   hp: 50,  atk: 64,  emoji: '🪨🦖',dexId: 246,rarity: 'Rare', category: 'Rock'      },
    // ── EPIC ──
    { name: 'Snorlax',    hp: 160, atk: 110, emoji: '😴', dexId: 143, rarity: 'Epic', category: 'Normal'    },
    { name: 'Dragonite',  hp: 91,  atk: 134, emoji: '🐲', dexId: 149, rarity: 'Epic', category: 'Dragon'    },
    { name: 'Alakazam',   hp: 55,  atk: 50,  emoji: '🥄', dexId: 65,  rarity: 'Epic', category: 'Psychic'   },
    { name: 'Tyranitar',  hp: 100, atk: 134, emoji: '🦖', dexId: 248, rarity: 'Epic', category: 'Dark'      },
    { name: 'Blaziken',   hp: 80,  atk: 120, emoji: '🔥🐓',dexId: 257,rarity: 'Epic', category: 'Fire'      },
    { name: 'Swampert',   hp: 100, atk: 110, emoji: '🌊🐊',dexId: 260,rarity: 'Epic', category: 'Water'     },
    { name: 'Sceptile',   hp: 70,  atk: 105, emoji: '🌿🦎',dexId: 254,rarity: 'Epic', category: 'Grass'     },
    { name: 'Metagross',  hp: 80,  atk: 135, emoji: '🔩🌀',dexId: 376,rarity: 'Epic', category: 'Steel'     },
    { name: 'Salamence',  hp: 95,  atk: 135, emoji: '🐉🔵',dexId: 373,rarity: 'Epic', category: 'Dragon'    },
    { name: 'Milotic',    hp: 95,  atk: 60,  emoji: '🌊🐍',dexId: 350,rarity: 'Epic', category: 'Water'     },
    // ── LEGENDARY ──
    { name: 'Articuno',   hp: 90,  atk: 85,  emoji: '🧊', dexId: 144, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zapdos',     hp: 90,  atk: 90,  emoji: '⚡', dexId: 145, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Moltres',    hp: 90,  atk: 100, emoji: '🔥', dexId: 146, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Latios',     hp: 80,  atk: 130, emoji: '💙🐉',dexId: 381,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Latias',     hp: 80,  atk: 110, emoji: '❤️🐉',dexId: 380,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Groudon',    hp: 100, atk: 150, emoji: '🌋🔴',dexId: 383,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Kyogre',     hp: 100, atk: 150, emoji: '🌊🔵',dexId: 382,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Giratina',   hp: 150, atk: 100, emoji: '👻🐉',dexId: 487,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Dialga',     hp: 100, atk: 120, emoji: '⏱️🐉',dexId: 483,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Palkia',     hp: 90,  atk: 120, emoji: '🌌🐉',dexId: 484,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Reshiram',   hp: 100, atk: 150, emoji: '🔥⚪',dexId: 643,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zekrom',     hp: 100, atk: 150, emoji: '⚡⚫',dexId: 644,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Kyurem',     hp: 125, atk: 130, emoji: '❄️🐉',dexId: 646,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Xerneas',    hp: 126, atk: 131, emoji: '🌺🦌',dexId: 716,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Yveltal',    hp: 126, atk: 131, emoji: '🌑🦅',dexId: 717,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zygarde',    hp: 216, atk: 100, emoji: '🌿🐍',dexId: 718,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Solgaleo',   hp: 137, atk: 137, emoji: '☀️🦁',dexId: 791,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Lunala',     hp: 137, atk: 137, emoji: '🌙🦇',dexId: 792,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zacian',     hp: 92,  atk: 170, emoji: '⚔️🐺',dexId: 888,rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zamazenta',  hp: 92,  atk: 130, emoji: '🛡️🐺',dexId: 889,rarity: 'Legendary', category: 'Legendary' },
    // ── MYTHICAL ──
    { name: 'Mew',        hp: 100, atk: 100, emoji: '🌟🐱',dexId: 151, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Celebi',     hp: 100, atk: 100, emoji: '🌿✨',dexId: 251, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Jirachi',    hp: 100, atk: 100, emoji: '⭐🔱',dexId: 385, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Deoxys',     hp: 50,  atk: 180, emoji: '👾🌌',dexId: 386, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Darkrai',    hp: 70,  atk: 135, emoji: '🌑😈',dexId: 491, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Shaymin',    hp: 100, atk: 100, emoji: '🌸🦔',dexId: 492, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Victini',    hp: 100, atk: 100, emoji: '🔥✌️',dexId: 494, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Genesect',   hp: 71,  atk: 120, emoji: '🔩🦟',dexId: 649, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Necrozma',   hp: 97,  atk: 107, emoji: '🌈🔱',dexId: 800, rarity: 'Mythical', category: 'Mythical' },
];

// ── FISH SELL PRICES ──────────────────────────────────────────────────────────
const FISH_SELL_PRICES = {
    fish:       { key: 'fish',      price: 200,  name: 'Standard Minnow Fish', emoji: '🐟' },
    salmon:     { key: 'salmon',    price: 800,  name: 'Premium Salmon',       emoji: '🐟' },
    goldenfish: { key: 'goldenFish',price: 5000, name: 'Legendary Golden Fish', emoji: '✨🐟' },
    golden:     { key: 'goldenFish',price: 5000, name: 'Legendary Golden Fish', emoji: '✨🐟' },
};

// ── HEIST PROTECTION KITS ────────────────────────────────────────────────────
const HEIST_KITS = {
    basic: {
        name: 'Basic Heist Shield 🛡️', price: 150000, emoji: '🛡️', tier: 1,
        desc: 'Reduces robbery loss by 40%. 35% chance to counter-fine the robber 10% of their wallet.',
        protectPct: 0.40, counterChance: 0.35, counterPct: 0.10,
    },
    advanced: {
        name: 'Advanced Heist Armor 🔒', price: 700000, emoji: '🔒', tier: 2,
        desc: 'Blocks 70% of robbery loss. 60% chance to counter-fine the robber 18% of their wallet.',
        protectPct: 0.70, counterChance: 0.60, counterPct: 0.18,
    },
    vault: {
        name: 'Vault Protocol 💎', price: 15000000, emoji: '💎', tier: 3,
        desc: '100% FULL PROTECTION. Nobody can rob you. Robber gets fined 25% of their wallet!',
        protectPct: 1.0, counterChance: 1.0, counterPct: 0.25,
    },
};

// ── AMAZON BAGS ───────────────────────────────────────────────────────────────
const AMAZON_BAGS = {
    tote:              { name: 'Canvas Tote Bag 🛍️',        price: 5000,     emoji: '🛍️', desc: 'Basic everyday carry. Simple but honest.' },
    skybag:            { name: 'Skybag Traveller 🎒',        price: 25000,    emoji: '🎒', desc: 'Great for trips and daily use.' },
    safari:            { name: 'Safari Duffle Bag 🟤',       price: 75000,    emoji: '🟤', desc: 'Rugged and spacious. Adventure-ready.' },
    aristocrat:        { name: 'Aristocrat Suitcase 🧳',     price: 200000,   emoji: '🧳', desc: 'Premium hard-shell luggage.' },
    americantourister: { name: 'American Tourister ✈️',      price: 500000,   emoji: '✈️', desc: 'Top-tier travel companion. Sleek design.' },
    gucci:             { name: 'Gucci Bag 💼',               price: 2500000,  emoji: '💼', desc: 'Luxury fashion statement. Flex on everyone.' },
    hermes:            { name: 'Hermès Birkin 👜',           price: 10000000, emoji: '👜', desc: 'Ultra-rare. The pinnacle of flex culture.' },
};

// ── CARD CATALOG ───────────────────────────────────────────────────────────────
const TIER_NAMES = { 1:'Common', 2:'Uncommon', 3:'Rare', 4:'Epic', 5:'Legendary', 6:'Mythic', 7:'GOD' };
const TIER_EMOJI = { 1:'⚪', 2:'🟢', 3:'🔵', 4:'🟣', 5:'🟡', 6:'🔴', 7:'🌟' };
const CARD_CATALOG = [
    // ── TIER 1 (60k) ──
    { id:1,  name:'Zenitsu Agatsuma',  anime:'Demon Slayer', tier:1, price:60000,   emoji:'⚡', img:'https://cdn.myanimelist.net/images/characters/7/461421.jpg' },
    { id:2,  name:'Inosuke Hashibira', anime:'Demon Slayer', tier:1, price:60000,   emoji:'🐗', img:'https://cdn.myanimelist.net/images/characters/2/461420.jpg' },
    { id:3,  name:'Tony Chopper',      anime:'One Piece',    tier:1, price:60000,   emoji:'🦌', img:'https://cdn.myanimelist.net/images/characters/5/93434.jpg' },
    { id:4,  name:'Usopp',             anime:'One Piece',    tier:1, price:60000,   emoji:'🎯', img:'https://cdn.myanimelist.net/images/characters/7/93417.jpg' },
    { id:5,  name:'Misa Amane',        anime:'Death Note',   tier:1, price:60000,   emoji:'💀', img:'https://cdn.myanimelist.net/images/characters/15/43531.jpg' },
    { id:6,  name:'Pikachu',           anime:'Pokémon',      tier:1, price:60000,   emoji:'⚡', img:'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png' },
    // ── TIER 2 (80k-100k) ──
    { id:7,  name:'Tanjiro Kamado',    anime:'Demon Slayer', tier:2, price:85000,   emoji:'🌊', img:'https://cdn.myanimelist.net/images/characters/1/461419.jpg' },
    { id:8,  name:'Nezuko Kamado',     anime:'Demon Slayer', tier:2, price:90000,   emoji:'🌸', img:'https://cdn.myanimelist.net/images/characters/3/461418.jpg' },
    { id:9,  name:'Nami',              anime:'One Piece',    tier:2, price:80000,   emoji:'🍊', img:'https://cdn.myanimelist.net/images/characters/14/93415.jpg' },
    { id:10, name:'Nico Robin',        anime:'One Piece',    tier:2, price:85000,   emoji:'🌺', img:'https://cdn.myanimelist.net/images/characters/9/127153.jpg' },
    { id:11, name:'L Lawliet',         anime:'Death Note',   tier:2, price:100000,  emoji:'🍰', img:'https://cdn.myanimelist.net/images/characters/11/136356.jpg' },
    { id:12, name:'Charizard',         anime:'Pokémon',      tier:2, price:90000,   emoji:'🔥', img:'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/6.png' },
    // ── TIER 3 (150k-180k) ──
    { id:13, name:'Kyojuro Rengoku',   anime:'Demon Slayer', tier:3, price:160000,  emoji:'🔥', img:'https://cdn.myanimelist.net/images/characters/14/461426.jpg' },
    { id:14, name:'Shinobu Kocho',     anime:'Demon Slayer', tier:3, price:155000,  emoji:'🦋', img:'https://cdn.myanimelist.net/images/characters/10/461423.jpg' },
    { id:15, name:'Roronoa Zoro',      anime:'One Piece',    tier:3, price:170000,  emoji:'⚔️', img:'https://cdn.myanimelist.net/images/characters/9/110013.jpg' },
    { id:16, name:'Sanji',             anime:'One Piece',    tier:3, price:165000,  emoji:'🦵', img:'https://cdn.myanimelist.net/images/characters/12/93418.jpg' },
    { id:17, name:'Light Yagami',      anime:'Death Note',   tier:3, price:175000,  emoji:'📓', img:'https://cdn.myanimelist.net/images/characters/8/40534.jpg' },
    { id:18, name:'Gengar',            anime:'Pokémon',      tier:3, price:150000,  emoji:'👻', img:'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/94.png' },
    // ── TIER 4 (350k-450k) ──
    { id:19, name:'Akaza',             anime:'Demon Slayer', tier:4, price:380000,  emoji:'💢', img:'https://cdn.myanimelist.net/images/characters/6/461427.jpg' },
    { id:20, name:'Doma',              anime:'Demon Slayer', tier:4, price:400000,  emoji:'🌀', img:'https://cdn.myanimelist.net/images/characters/11/461430.jpg' },
    { id:21, name:'Monkey D. Luffy',   anime:'One Piece',    tier:4, price:420000,  emoji:'🦁', img:'https://cdn.myanimelist.net/images/characters/9/310307.jpg' },
    { id:22, name:'Trafalgar Law',     anime:'One Piece',    tier:4, price:360000,  emoji:'💛', img:'https://cdn.myanimelist.net/images/characters/9/170176.jpg' },
    { id:23, name:'Near',              anime:'Death Note',   tier:4, price:350000,  emoji:'🤍', img:'https://cdn.myanimelist.net/images/characters/14/43530.jpg' },
    { id:24, name:'Mewtwo',            anime:'Pokémon',      tier:4, price:450000,  emoji:'🌌', img:'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/150.png' },
    // ── TIER 5 (550k-700k) ──
    { id:25, name:'Kokushibo',         anime:'Demon Slayer', tier:5, price:620000,  emoji:'🌙', img:'https://cdn.myanimelist.net/images/characters/8/461432.jpg' },
    { id:26, name:'Shanks',            anime:'One Piece',    tier:5, price:680000,  emoji:'⚓', img:'https://cdn.myanimelist.net/images/characters/10/212993.jpg' },
    { id:27, name:'Whitebeard',        anime:'One Piece',    tier:5, price:650000,  emoji:'🌊', img:'https://cdn.myanimelist.net/images/characters/12/234795.jpg' },
    { id:28, name:'Ryuk',              anime:'Death Note',   tier:5, price:600000,  emoji:'👁️', img:'https://cdn.myanimelist.net/images/characters/7/40542.jpg' },
    { id:29, name:'Lugia',             anime:'Pokémon',      tier:5, price:700000,  emoji:'🦅', img:'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/249.png' },
    // ── TIER 6 (850k-1M) ──
    { id:30, name:'Muzan Kibutsuji',   anime:'Demon Slayer', tier:6, price:950000,  emoji:'🌹', img:'https://cdn.myanimelist.net/images/characters/5/461433.jpg' },
    { id:31, name:'Kaido',             anime:'One Piece',    tier:6, price:950000,  emoji:'🐉', img:'https://cdn.myanimelist.net/images/characters/12/384305.jpg' },
    { id:32, name:'Big Mom',           anime:'One Piece',    tier:6, price:880000,  emoji:'🎂', img:'https://cdn.myanimelist.net/images/characters/9/355553.jpg' },
    { id:33, name:'God Ryuk',          anime:'Death Note',   tier:6, price:1000000, emoji:'☠️', img:'https://cdn.myanimelist.net/images/characters/7/40542.jpg' },
    { id:34, name:'Arceus',            anime:'Pokémon',      tier:6, price:850000,  emoji:'👑', img:'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/493.png' },
    // ── TIER 7 (2M-5M, GOD TIER) ──
    { id:35, name:'Yoriichi Tsugikuni',anime:'Demon Slayer', tier:7, price:3000000, emoji:'☀️', img:'https://cdn.myanimelist.net/images/characters/7/461434.jpg' },
    { id:36, name:'Gol D. Roger',      anime:'One Piece',    tier:7, price:4000000, emoji:'🏴‍☠️', img:'https://cdn.myanimelist.net/images/characters/9/210430.jpg' },
    { id:37, name:'Im-sama',           anime:'One Piece',    tier:7, price:5000000, emoji:'👑', img:'https://cdn.myanimelist.net/images/characters/7/435621.jpg' },
    { id:38, name:'Kira (God Mode)',   anime:'Death Note',   tier:7, price:2500000, emoji:'🔱', img:'https://cdn.myanimelist.net/images/characters/8/40534.jpg' },
    { id:39, name:'Rayquaza',          anime:'Pokémon',      tier:7, price:2000000, emoji:'🌟', img:'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/384.png' },
];

// ── LOAN TIER CONFIG ───────────────────────────────────────────────────────────
const LOAN_TIERS = {
    1: { maxLoan:20000,   interest:5,  days:1  },
    2: { maxLoan:40000,   interest:6,  days:2  },
    3: { maxLoan:100000,  interest:8,  days:3  },
    4: { maxLoan:250000,  interest:10, days:7  },
    5: { maxLoan:400000,  interest:12, days:10 },
    6: { maxLoan:600000,  interest:13, days:12 },
    7: { maxLoan:2000000, interest:15, days:21 },
};

// ── COOLDOWNS (seconds) ───────────────────────────────────────────────────────
const CD_DIG = 45, CD_FISH = 45, CD_CASINO = 300, CD_SLOTS = 60,
      CD_DB = 60, CD_ROULETTE = 40, CD_COINFLIP = 60, CD_CHEAT = 600, CD_ROB = 300;

const AVAILABLE_BAGS = ['Skybag', 'Safari Bag', 'Aristocrat Bag', 'Gucci Bag 💼', 'American Tourister'];

const ROAST_MESSAGES = [
    "Look at this script kiddie trying to run dev cheats in a group! Go execute `.dig` and work hard for once. 🤡",
    "Bro really thought he could hack his way into wealth while everyone was watching. Absolute clown energy! 🧠❌",
    "Nice try, master hacker! Next time try executing your masterplans in my DMs, not in public. How embarrassing! 😂"
];

// ── CATCH GIF URL ─────────────────────────────────────────────────────────────
const POKEBALL_GIF_URL = 'https://media.tenor.com/5n7JF3bVDfYAAAAC/pokeball-throw.gif';

// ── DB HELPERS ────────────────────────────────────────────────────────────────
// ── SAFE DB LOAD with backup ─────────────────────────────────────────────────
const DB_BACKUP = DB_FILE + '.bak';
if (fs.existsSync(DB_FILE)) {
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        if (!raw || raw.trim() === '') throw new Error('Empty file');
        db = JSON.parse(raw);
        // Save a good backup every time we load successfully
        fs.writeFileSync(DB_BACKUP, raw);
        console.log(`✅ Database loaded (${Object.keys(db).length} entries)`);
    } catch (e) {
        console.error(`⚠️ database.json corrupted: ${e.message} — trying backup...`);
        if (fs.existsSync(DB_BACKUP)) {
            try {
                db = JSON.parse(fs.readFileSync(DB_BACKUP, 'utf8'));
                console.log('✅ Restored from backup!');
            } catch (e2) {
                console.error('❌ Backup also corrupted. Starting fresh.');
                db = {};
            }
        } else {
            console.error('❌ No backup found. Starting fresh.');
            db = {};
        }
    }
} else {
    console.log('ℹ️ No database found — starting fresh.');
}
if (!db._config) db._config = { botActive: true };
// Per-GC active state: { [chatId]: true/false }
if (!db._config.gcActive)  db._config.gcActive  = {};
// Lobby GCs set: { [chatId]: true }
if (!db._config.lobbyGCs)  db._config.lobbyGCs  = {};

// Helper: is bot active in this specific chat?
function isBotActiveInChat(chatId) {
    // If per-GC entry exists, use it; otherwise fall back to global flag
    if (db._config.gcActive[chatId] !== undefined) return db._config.gcActive[chatId];
    return db._config.botActive;
}

// Helper: is this chat a lobby GC?
function isLobbyGC(chatId) {
    return !!db._config.lobbyGCs[chatId];
}

// Commands blocked in lobby GCs (gambling + pokemon catching/play)
const LOBBY_BLOCKED_COMMANDS = new Set([
    '.casino', '.slots', '.roulette', '.db', '.double', '.cf', '.coinflip',
    '.rob', '.catch', '.throwball', '.play'
]);


function saveDB() {
    try {
        const data = JSON.stringify(db, null, 2);
        const tmp = DB_FILE + '.tmp';
        fs.writeFileSync(tmp, data);   // write to temp first
        fs.renameSync(tmp, DB_FILE);   // atomic swap — prevents corruption on crash
    } catch (err) { console.error('DB save error:', err); }
}

function initUser(userId) {
    // FIX: skip invalid/non-Discord IDs (old WhatsApp keys, placeholders, etc.)
    if (!userId || !/^\d{17,19}$/.test(userId)) return;
    if (!db[userId]) db[userId] = {};
    const u = db[userId];
    if (u.wallet === undefined)       u.wallet = 550000;
    if (u.bank === undefined)         u.bank = 0;
    if (u.maxCapacity === undefined)  u.maxCapacity = 7700000;
    if (u.lastDig === undefined)      u.lastDig = 0;
    if (u.lastFish === undefined)     u.lastFish = 0;
    if (u.lastCasino === undefined)   u.lastCasino = 0;
    if (u.lastSlots === undefined)    u.lastSlots = 0;
    if (u.lastDb === undefined)       u.lastDb = 0;
    if (u.lastRoulette === undefined) u.lastRoulette = 0;
    if (u.lastCoinflip === undefined) u.lastCoinflip = 0;
    if (u.lastCheat === undefined)    u.lastCheat = 0;
    if (u.lastDaily === undefined)    u.lastDaily = 0;
    if (u.dailyStreak === undefined)  u.dailyStreak = 0;
    if (u.lastRob === undefined)      u.lastRob = 0;
    if (u.dailyDbCount === undefined) u.dailyDbCount = 0;
    if (u.lastLimitReset === undefined) u.lastLimitReset = Date.now();
    if (u.inventory === undefined)    u.inventory = {};
    const inv = u.inventory;
    if (inv.shovel === undefined)       inv.shovel = 1;
    if (inv.fishingRod === undefined)   inv.fishingRod = 1;
    if (inv.pokeball === undefined)     inv.pokeball = 5;
    if (inv.greatball === undefined)    inv.greatball = 0;
    if (inv.ultraball === undefined)    inv.ultraball = 0;
    if (inv.masterball === undefined)   inv.masterball = 0;
    if (inv.heavyball === undefined)    inv.heavyball = 0;
    if (inv.lureball === undefined)     inv.lureball = 0;
    if (inv.assignedBag === undefined)  inv.assignedBag = AVAILABLE_BAGS[Math.floor(Math.random() * AVAILABLE_BAGS.length)];
    if (inv.fish === undefined)         inv.fish = 0;
    if (inv.salmon === undefined)       inv.salmon = 0;
    if (inv.goldenFish === undefined)   inv.goldenFish = 0;
    // Food items
    for (let key of Object.keys(FOOD_SHOP)) {
        if (inv[key] === undefined) inv[key] = 0;
    }
    if (u.pokemon === undefined) u.pokemon = [];
    // mrbeast daily usage per pokemon: { pokemonName: { count, lastReset } }
    if (u.mrbeastDaily === undefined) u.mrbeastDaily = {};
    // Permanent ATK boost from food (cumulative, saved to DB)
    if (u.permAtkBoost === undefined) u.permAtkBoost = {};
    // Toxicity tracker per pokemon: { pokemonName: { alcoholCount, cigarCount, toxicUntil } }
    if (u.toxicity === undefined) u.toxicity = {};
    // ATK buffs from food (temporary, per battle): stored but reset after use
    if (u.atkBuff === undefined) u.atkBuff = 0;
    // Card inventory
    if (u.cardInventory === undefined) u.cardInventory = [];
    // Loan system
    if (u.loan === undefined) u.loan = null;
    // Heist protection kit
    if (u.activeHeistKit === undefined) u.activeHeistKit = null;
    // Track when user first joined
    if (u.joinedAt === undefined) u.joinedAt = Date.now();
}

function checkDailyReset(userId) {
    const now = Date.now();
    if (now - db[userId].lastLimitReset > 86400000) {
        db[userId].dailyDbCount = 0;
        db[userId].lastLimitReset = now;
        saveDB();
    }
}

function makeProgressBar(current, max) {
    const total = 8;
    const filled = Math.max(0, Math.min(total, Math.round((current / max) * total)));
    return '🟩'.repeat(filled) + '⬜'.repeat(total - filled);
}

// Track last 5 spawned Pokémon per chat to avoid repeats
const recentSpawns = {};

function pickWildPokemon(chatId) {
    const roll = Math.random() * 100;
    let pool;
    if (roll <= 30)      pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Weak');
    else if (roll <= 58) pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Common');
    else if (roll <= 78) pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Rare');
    else if (roll <= 90) pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Epic');
    else if (roll <= 97) pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Legendary');
    else                 pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Mythical');

    // Anti-repeat: filter out recently spawned Pokémon in this chat
    if (chatId) {
        if (!recentSpawns[chatId]) recentSpawns[chatId] = [];
        const recent = recentSpawns[chatId];
        const filtered = pool.filter(p => !recent.includes(p.name));
        if (filtered.length > 0) pool = filtered;
        // Track this spawn
        const pick = { ...pool[Math.floor(Math.random() * pool.length)] };
        recent.push(pick.name);
        if (recent.length > 5) recent.shift();
        return pick;
    }
    return { ...pool[Math.floor(Math.random() * pool.length)] };
}

// { chatId: lastSpawnTime }
const lastSpawnTime = {};

function checkWildSpawn(chatId) {
    if (wildPokemonState[chatId]) return false; // already a wild pokemon active
    const now = Date.now();
    const last = lastSpawnTime[chatId] || 0;
    // 15-20 minute cooldown between spawns
    const cdMs = (Math.floor(Math.random() * 6) + 15) * 60 * 1000;
    if (now - last >= cdMs) {
        lastSpawnTime[chatId] = now;
        return true;
    }
    return false;
}

function generateBattleId() {
    return 'BT' + Date.now().toString(36).toUpperCase();
}

function isToxic(userId, pokeName) {
    const tox = db[userId]?.toxicity?.[pokeName.toLowerCase()];
    if (!tox) return false;
    return tox.toxicUntil && Date.now() < tox.toxicUntil;
}

function getToxicInfo(userId, pokeName) {
    return db[userId]?.toxicity?.[pokeName.toLowerCase()] || { alcoholCount: 0, cigarCount: 0, toxicUntil: 0 };
}

// ── CLIENT EVENTS ─────────────────────────────────────────────────────────────
client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('👉 Scan QR:'); });
client.on('ready', () => console.log('🚀 BOT ONLINE — ALL SYSTEMS GO'));

// ── MAIN MESSAGE HANDLER ──────────────────────────────────────────────────────
client.on('messageCreate', async msg => {
    // FIX: partial messages/authors (Partials.Message is enabled) can arrive
    // with msg.author missing .id until explicitly fetched — resolve that first.
    try {
        if (msg.partial) msg = await msg.fetch();
        if (!msg.author) return;
        if (typeof msg.author !== "string" && !msg.author.id) return;
    } catch (e) {
        console.error('Partial fetch failed:', e.message);
        return;
    }
    if (!msg.__wrapped && msg.author.bot) return;  // FIX: guard against system/webhook messages
    msg = wrapMessage(msg);
    try {
        let body = msg.body ? msg.body.trim() : '';
        body = body.replace(/^\.\s+/, '.');
        const senderId = msg.author || msg.from;
        if (!body) return;

        const chatObj = await msg.getChat();
        const isGroupChat = chatObj.isGroup;

        let isMod = await checkIsMod(msg);

        // ── Handle active battle move replies ────────────────────────────────
        // Players reply with a move name like "Thunderbolt" or "1" (move index)
        const lowerBody = body.toLowerCase().trim();

        // Check if this user is in an active battle and replying with a move
        for (const [battleId, battle] of Object.entries(activeBattles)) {
            const isP1Turn = battle.turn === 'p1' && senderId === battle.p1Id;
            const isP2Turn = battle.turn === 'p2' && senderId === battle.p2Id;
            if (!isP1Turn && !isP2Turn) continue;

            const myPoke   = isP1Turn ? battle.p1 : battle.p2;
            const oppPoke  = isP1Turn ? battle.p2 : battle.p1;
            const myId     = senderId;
            const oppId    = isP1Turn ? battle.p2Id : battle.p1Id;
            const myName   = myId.split('@')[0];
            const oppName  = oppId.split('@')[0];

            const moves = getMovesForPokemon(myPoke.name);
            let chosenMove = null;

            // match by number (1-4) or name
            const numMatch = parseInt(lowerBody);
            if (!isNaN(numMatch) && numMatch >= 1 && numMatch <= moves.length) {
                chosenMove = moves[numMatch - 1];
            } else {
                chosenMove = moves.find(m => m.name.toLowerCase() === lowerBody);
            }
            if (!chosenMove) break; // not a valid move, ignore

            // Calculate damage
            const dmg = Math.floor(Math.random() * (chosenMove.damage[1] - chosenMove.damage[0] + 1)) + chosenMove.damage[0];
            oppPoke.hp = Math.max(0, oppPoke.hp - dmg);

            let moveMsg = `⚔️ *${myPoke.emoji} ${myPoke.name}* used *${chosenMove.emoji} ${chosenMove.name}*!\n` +
                          `💥 Dealt *${dmg} damage* to ${oppPoke.emoji} ${oppPoke.name}!\n` +
                          `❤️ ${oppPoke.name} HP: ${makeProgressBar(oppPoke.hp, oppPoke.maxHp)} (${oppPoke.hp}/${oppPoke.maxHp})\n`;

            if (oppPoke.hp <= 0) {
                // Battle over
                delete activeBattles[battleId];

                if (battle.wildMode) {
                    // Wild Pokémon defeated — chance to catch
                    const wild = battle.wildPokemon;
                    moveMsg += `\n🏆 *${myPoke.name} wins!* Wild ${wild.emoji} ${wild.name} is weakened!\n\n`;
                    moveMsg += `🎯 Use *.throwball [balltype]* to try catching it!\n` +
                               `_(e.g. \`.throwball pokeball\` or \`.throwball ultraball\`)_\n` +
                               `⚠️ Wild Pokémon flees in 30 seconds if not caught!`;
                    wildPokemonState[chatObj.id._serialized] = {
                        pokemon: { ...wild, hp: 1 },
                        spawnTime: Date.now(),
                        weakened: true,
                        battleWinner: myId
                    };
                    // Auto-flee after 30s
                    setTimeout(() => {
                        const cid = chatObj.id._serialized;
                        if (wildPokemonState[cid]?.weakened) {
                            delete wildPokemonState[cid];
                            chatObj.sendMessage(`💨 The weakened ${wild.emoji} ${wild.name} recovered and fled into the wild!`).catch(() => {});
                        }
                    }, 30000);
                } else {
                    // PvP battle over
                    const winnerId  = myId;
                    const loserId   = oppId;
                    const prize = 50000;
                    initUser(winnerId); initUser(loserId);

                    // Sync HP back to DB
                    const updatePokeHp = (uid, poke) => {
                        const party = db[uid].pokemon || [];
                        const found = party.find(p => p.name.toLowerCase() === poke.name.toLowerCase());
                        if (found) { found.hp = poke.hp; }
                    };
                    updatePokeHp(myId, myPoke);
                    updatePokeHp(oppId, oppPoke);
                    db[winnerId].wallet += prize;
                    saveDB();
                    moveMsg += `\n🏆 *${myPoke.emoji} ${myPoke.name}* won the battle!\n` +
                               `💰 *Prize: +$${prize.toLocaleString()}* awarded to @${myName}!\n\n` +
                               `💡 Heal your Pokémon with \`.feed\` before the next battle.`;
                }
                return chatObj.sendMessage(moveMsg, { mentions: [myId, oppId] }).catch(() => {});
            }

            // Switch turn
            battle.turn = isP1Turn ? 'p2' : 'p1';
            const nextId   = isP1Turn ? battle.p2Id : battle.p1Id;
            const nextPoke = isP1Turn ? battle.p2 : battle.p1;
            const nextMoves = getMovesForPokemon(nextPoke.name);
            moveMsg += `\n⏳ <@${nextId}>'s turn! *${nextPoke.emoji} ${nextPoke.name}*'s moves:\n`;
            nextMoves.forEach((m, i) => { moveMsg += `${i+1}. ${m.emoji} *${m.name}* (${m.damage[0]}-${m.damage[1]} dmg)${m.special ? ' ✨' : ''}\n`; });
            moveMsg += `\nReply with move number or name!`;
            return chatObj.sendMessage(moveMsg, { mentions: [nextId] }).catch(() => {});
        }

        // Only process dot-commands from here
        if (!body.startsWith('.')) return;
        const chatId = chatObj.id._serialized;
        const _botActiveHere = isBotActiveInChat(chatId);
        if (!_botActiveHere && body !== '.bot on' && body !== '.bot off' && body !== '.lobby' && body !== '.unlobby' && body !== '.kick' && !body.startsWith('.pp') && !body.startsWith('.addmoney') && body !== '.mods' && body !== '.owners' && body !== '.help') return;

        const args = body.split(' ').filter(a => a !== '');
        const command = args[0].toLowerCase();

        // ── LOBBY GC: block forbidden commands ───────────────────────────────
        if (isGroupChat && isLobbyGC(chatId) && LOBBY_BLOCKED_COMMANDS.has(command)) {
            return msg.reply('🏛️ *Lobby GC Mode* — This command is not available here.\n_Gambling & Pokemon catching are disabled in lobby groups._').catch(() => {});
        }

        // ── WILD SPAWN CHECK — skip in lobby GCs ────────────────────────────
        if (isGroupChat && command !== '.catch' && command !== '.throwball' && !isLobbyGC(chatId)) {
            if (checkWildSpawn(chatObj.id._serialized)) {
                const wild = pickWildPokemon(chatObj.id._serialized);
                const cid = chatObj.id._serialized;
                wildPokemonState[cid] = { pokemon: { ...wild, currentHp: wild.hp }, spawnTime: Date.now(), weakened: false };

                const spawnCard = `🌿 *A WILD POKÉMON APPEARED IN THE TALL GRASS!* 🌿\n` +
                                  `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                                  `${wild.emoji} *${wild.name}* [${wild.rarity}] appeared!\n` +
                                  `❤️ HP: ${wild.hp} | ⚔️ ATK: ${wild.atk}\n\n` +
                                  `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                                  `🥊 Type *.catch* to battle it!\n` +
                                  `_(Flees in 3 minutes if nobody challenges!)_`;
                try {
                    const artUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${wild.dexId}.png`;
                    const media = await MessageMedia.fromUrl(artUrl);
                    await chatObj.sendMessage(media, { caption: spawnCard });
                } catch (_) {
                    await chatObj.sendMessage(spawnCard);
                }
                setTimeout(() => {
                    if (wildPokemonState[cid] && !wildPokemonState[cid].weakened) {
                        delete wildPokemonState[cid];
                        chatObj.sendMessage(`💨 *Wild ${wild.emoji} ${wild.name} fled into the bushes!* Nobody was brave enough.`).catch(() => {});
                    }
                }, 3 * 60 * 1000);
            }
        }

        // ── .mods / .help ─────────────────────────────────────────────────────
        if (command === '.mods' || command === '.help') {
            const requester = senderId.split('@')[0];
            let adminIds = [];
            if (isGroupChat && chatObj.participants) {
                adminIds = chatObj.participants
                    .filter(p => p.isAdmin || p.isSuperAdmin)
                    .map(p => p.id._serialized);
            }
            for (const m of MOD_NUMBERS) {
                if (!adminIds.includes(m)) adminIds.push(m);
            }
            const adminTags = adminIds.map(id => `• <@${id}>`).join('\n');
            const modMsg = `📢 *MOD ALERT — HELP NEEDED!* 📢\n` +
                           `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                           `⚠️ @${requester} from this group needs assistance!\n\n` +
                           `👮 Tagging Admins/Moderators:\n${adminTags}\n\n` +
                           `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                           `_Please attend to the group as soon as possible!_`;
            return chatObj.sendMessage(modMsg, { mentions: [senderId, ...adminIds] }).catch(() => {});
        }


        // ── .debugme — full raw debug ─────────────────────────────────────────
        if (command === '.debugme') {
            try {
                const parts = chatObj.participants || [];
                const adminList = parts.filter(p => p.isAdmin || p.isSuperAdmin).map(p => p.id?._serialized);
                // Re-check isMod fresh with detailed logging
                const rawAuthorId = typeof msg.author === 'string' ? msg.author : (msg.author?.id || 'UNDEFINED');
                const inModList = MOD_NUMBERS.includes(rawAuthorId);
                let memberPerms = 'N/A';
                if (msg.guild) {
                    const m = await msg.guild.members.fetch(rawAuthorId).catch(() => null);
                    if (m) memberPerms = [...m.permissions.toArray()].join(', ');
                    else memberPerms = 'Member not found in guild';
                }
                return msg.reply(
                    '🔍 *DEBUG INFO*\n' +
                    '━━━━━━━━━━━━━━━━━━━━\n' +
                    '🆔 Your ID: `' + rawAuthorId + '`\n' +
                    '📋 MOD_NUMBERS: `' + MOD_NUMBERS.join(', ') + '`\n' +
                    '✅ In MOD list: ' + inModList + '\n' +
                    '👮 isMod result: ' + isMod + '\n' +
                    '🏠 Has guild: ' + !!msg.guild + '\n' +
                    '👥 Participants fetched: ' + parts.length + '\n' +
                    '🛡️ Admins in server: ' + (adminList.join(', ') || 'none') + '\n' +
                    '🔑 Your permissions: ' + memberPerms
                ).catch(() => {});
            } catch(e) {
                return msg.reply('debug error: ' + e.message).catch(() => {});
            }
        }
        // ── .owners ───────────────────────────────────────────────────────────
        if (command === '.owners') {
            // No isMod check — anyone can see who the owners are
            const ownerTags = MOD_NUMBERS.map(m => `• <@${m}>`).join('\n');
            const ownerMsg = `👑 *GROUP OWNERS* 👑\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                             `${ownerTags}\n\n` +
                             `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
            return chatObj.sendMessage(ownerMsg, { mentions: MOD_NUMBERS }).catch(() => {});
        }

        // ── .gamble ───────────────────────────────────────────────────────────
        if (command === '.gamble') {
            return msg.reply(
                `🎰 *CASINO DISTRICT — GAMBLING GUIDE* 🎰\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `🎰 *.casino [bet]* — Slot machine. Win or lose your bet. (CD: 5 min)\n\n` +
                `🎰 *.slots [bet]* — 3-reel slots. Match 3 = 4x payout! (CD: 1 min)\n\n` +
                `🎡 *.roulette [red/black/green] [bet]* — Spin the wheel. Green pays 14x! (CD: 40s)\n\n` +
                `⚖️ *.db [bet]* or *.double [bet]* — Double or Nothing! 48% win chance. Max 15/day. (CD: 1 min)\n\n` +
                `🪙 *.cf [heads/tails] [bet]* or *.coinflip* — Classic coin flip. (CD: 1 min)\n\n` +
                `🦹 *.rob [@user]* — Attempt to rob another player's wallet! (CD: 5 min, groups only)\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `💡 _All games are luck-based. Gamble responsibly!_`
            );
        }

        // ── DEV CHEATS ────────────────────────────────────────────────────────
        if (command === '.jatha69' || command === '.boojho' || command === '.xxx') {
            if (!isMod) return msg.reply('❌ System privileges denied.');
            if (isGroupChat) {
                const roast = ROAST_MESSAGES[Math.floor(Math.random() * ROAST_MESSAGES.length)];
                return chatObj.sendMessage(`🔥 <@${senderId}> ${roast}`, { mentions: [senderId] }).catch(() => {});
            }
            initUser(senderId);
            const now = Date.now();
            if ((now - db[senderId].lastCheat) / 1000 < CD_CHEAT) {
                let left = Math.ceil(CD_CHEAT - (now - db[senderId].lastCheat) / 1000);
                return msg.reply(`⏳ Dev engine on cooldown. Wait *${Math.floor(left/60)}m ${left%60}s*.`);
            }
            let amt = command === '.jatha69' ? 1000000 : command === '.boojho' ? 2000000 : 50000000;
            db[senderId].lastCheat = now;
            db[senderId].wallet += amt;
            saveDB();
            return msg.reply(`⚙️ Dev Vault Injection: *+$${amt.toLocaleString()}* loaded.`);
        }

        if (command === '.addmoney') {
            if (!isMod) return msg.reply('❌ Privileged engine command locked.');
            let targetUser = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : (msg.mentionedIds[0] || senderId);
            let amtStr = msg.hasQuotedMsg ? args[1] : (msg.mentionedIds[0] ? args[2] : args[1]);
            let amount = parseInt(amtStr);
            if (isNaN(amount)) return msg.reply('❌ Syntax: `.addmoney [amount]`');
            initUser(targetUser); db[targetUser].wallet += amount; saveDB();
            return msg.reply(`💰 Injected *+$${amount.toLocaleString()}* to <@${targetUser}>`);
        }

        if (command === '.bot') {
            if (!isMod) return msg.reply('❌ Only group admins can use this command.');
            const action = args[1] ? args[1].toLowerCase() : '';
            if (action === 'off') {
                if (isGroupChat) { db._config.gcActive[chatId] = false; }
                else { db._config.botActive = false; }
                saveDB();
                return msg.reply('🔴 Bot deactivated in *this* group.');
            } else if (action === 'on') {
                if (isGroupChat) { db._config.gcActive[chatId] = true; }
                else { db._config.botActive = true; }
                saveDB();
                return msg.reply('🟢 Bot active in *this* group.');
            } else return msg.reply('❌ Usage:  or ');
        }

        // ── .lobby — mark/unmark this GC as a lobby ──────────────────────────
        if (command === '.lobby') {
            if (!isMod) return msg.reply('❌ Only group admins can use this command.');
            if (!isGroupChat) return msg.reply('❌ This command only works in groups.');
            db._config.lobbyGCs[chatId] = true; saveDB();
            return msg.reply(
                '🏛️ *LOBBY GC MODE ACTIVATED* 🏛️\n' +
                '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n' +
                '✅ This group is now a *Lobby GC*.\n\n' +
                '📋 *Allowed:* .menu .bal .transfer .wealthy .health .inv .food .buy .cards .amazon .battle .mods .help .owners .bot\n\n' +
                '❌ *Disabled:* All gambling, Pokemon catching & wild spawns\n\n' +
                '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n' +
                '_Type .unlobby to remove lobby mode_'
            );
        }
        if (command === '.unlobby') {
            if (!isMod) return msg.reply('❌ Only group admins can use this command.');
            if (!isGroupChat) return msg.reply('❌ This command only works in groups.');
            delete db._config.lobbyGCs[chatId]; saveDB();
            return msg.reply('✅ Lobby GC mode removed. All features restored.');
        }

        if (!_botActiveHere) return;

        // ── PROFILE / BALANCE ─────────────────────────────────────────────────
        if (command === '.bal' || command === '.p' || command === '.profile') {
            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : (msg.mentionedIds[0] || senderId);
            initUser(target); const u = db[target];
            return msg.reply(
                `💳 *FEDERAL ASSET MONITOR* 📝\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `💰 *Wallet:* 〔 $${u.wallet.toLocaleString()} 〕\n` +
                `🏦 *Bank:* 〔 $${u.bank.toLocaleString()} 〕\n\n` +
                `💎 *Net Wealth:* 〔 $${(u.wallet + u.bank).toLocaleString()} 〕\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
            );
        }

        // ── .dig ──────────────────────────────────────────────────────────────
        if (command === '.dig') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastDig) / 1000 < CD_DIG) {
                let left = Math.ceil(CD_DIG - (now - db[senderId].lastDig) / 1000);
                return msg.reply(`⏳ Your hands are tired! Wait *${left}s*.`);
            }
            db[senderId].lastDig = now;
            const chance = Math.random() * 100;
            if (chance <= 15) {
                let loss = Math.min(Math.floor(Math.random() * 800) + 500, db[senderId].wallet);
                db[senderId].wallet -= loss; saveDB();
                return msg.reply(`🪦 A zombie jumped out and stole *-$${loss.toLocaleString()}*! 🧟‍♂️`);
            } else if (chance <= 50) {
                saveDB();
                return msg.reply(`⛏️ You spent an hour digging and found only worms. What a waste.`);
            } else {
                let win = Math.floor(Math.random() * 1200) + 600;
                db[senderId].wallet += win; saveDB();
                return msg.reply(`⛏️ Found a buried lockbox! Gained: *+$${win.toLocaleString()}*`);
            }
        }

        // ── .fish ─────────────────────────────────────────────────────────────
        if (command === '.fish') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastFish) / 1000 < CD_FISH) {
                let left = Math.ceil(CD_FISH - (now - db[senderId].lastFish) / 1000);
                return msg.reply(`⏳ Wait *${left}s* for fish to gather back.`);
            }
            db[senderId].lastFish = now;
            const roll = Math.random() * 100;
            if (roll <= 12) {
                let loss = Math.min(Math.floor(Math.random() * 1500) + 1000, db[senderId].wallet);
                db[senderId].wallet -= loss; saveDB();
                return msg.reply(`🦈 *SHARK ATTACK!* You lost *-$${loss.toLocaleString()}*! 🌊`);
            } else if (roll <= 25) {
                db[senderId].inventory.goldenFish = (db[senderId].inventory.goldenFish || 0) + 1; saveDB();
                return msg.reply(`🎣 *LEGENDARY!* You caught a *✨ Golden Fish*! Check \`.inv\``);
            } else if (roll <= 55) {
                db[senderId].inventory.salmon = (db[senderId].inventory.salmon || 0) + 1; saveDB();
                return msg.reply(`🎣 *Nice catch!* You reeled in a premium *🐟 Salmon*!`);
            } else if (roll <= 80) {
                // BUG FIX: store the minnow fish in inventory instead of giving coins
                db[senderId].inventory.fish = (db[senderId].inventory.fish || 0) + 1; saveDB();
                return msg.reply(`🎣 You caught a small *🐟 Minnow Fish*! Sell it with \`.sell fish\`.`);
            } else {
                saveDB();
                return msg.reply(`🎣 Sat on the dock for 45 minutes. Nothing bit. Go home.`);
            }
        }

        // ── .casino ───────────────────────────────────────────────────────────
        if (command === '.casino') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastCasino) / 1000 < CD_CASINO) {
                let left = Math.ceil(CD_CASINO - (now - db[senderId].lastCasino) / 1000);
                return msg.reply(`🎰 Casino threw you out. Wait *${Math.floor(left/60)}m ${left%60}s*.`);
            }
            let bet = parseInt(args[1]);
            if (isNaN(bet) || bet <= 0 || bet > db[senderId].wallet) return msg.reply('❌ Enter a real bet you own.');
            db[senderId].lastCasino = now;
            const syms = ['🎲','🎰','💎','🃏','💰'];
            let r1 = syms[Math.floor(Math.random()*syms.length)];
            let r2 = syms[Math.floor(Math.random()*syms.length)];
            let r3 = syms[Math.floor(Math.random()*syms.length)];
            let layout = `🎰 *LAS VEGAS PREMIUM CASINO* 🎰\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n  [ ${r1} | ${r2} | ${r3} ]  \n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            if (Math.random() * 100 <= 62) {
                db[senderId].wallet += bet; saveDB();
                layout += `🟢 *WINNER!* You got: *+$${bet.toLocaleString()}*\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}`;
            } else {
                db[senderId].wallet -= bet; saveDB();
                layout += `😢 *HOUSE WINS!* Lost: *-$${bet.toLocaleString()}*\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}`;
            }
            return msg.reply(layout);
        }

        // ── .slots ────────────────────────────────────────────────────────────
        if (command === '.slots') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastSlots) / 1000 < CD_SLOTS) {
                let left = Math.ceil(CD_SLOTS - (now - db[senderId].lastSlots) / 1000);
                return msg.reply(`⏳ Lever stuck! Wait *${left}s*.`);
            }
            let bet = parseInt(args[1]);
            if (isNaN(bet) || bet <= 0 || bet > db[senderId].wallet) return msg.reply('❌ Usage: `.slots [bet]`');
            db[senderId].lastSlots = now;
            const items = ['🍎','💎','🍓','🍒','🔔'];
            let r1, r2, r3;
            const slotRoll = Math.random() * 100;
            if (slotRoll < 10) {
                // 10% jackpot - force 3 match
                r1 = r2 = r3 = items[Math.floor(Math.random()*items.length)];
            } else if (slotRoll < 50) {
                // 40% mini win - force 2 match
                r1 = r2 = items[Math.floor(Math.random()*items.length)];
                do { r3 = items[Math.floor(Math.random()*items.length)]; } while (r3 === r1);
            } else {
                // 50% pure random (likely loss)
                r1 = items[Math.floor(Math.random()*items.length)];
                r2 = items[Math.floor(Math.random()*items.length)];
                r3 = items[Math.floor(Math.random()*items.length)];
            }
            let layout = `🎰 *SLOT MACHINE CORE* 🎰\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n  [ ${r1} | ${r2} | ${r3} ]  \n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            if (r1===r2 && r2===r3) {
                let payout = bet*4; db[senderId].wallet += payout; saveDB();
                layout += `🎉 *JACKPOT!* 3x Match! Earned *+$${payout.toLocaleString()}*!`;
            } else if (r1===r2 || r2===r3 || r1===r3) {
                let payout = Math.floor(bet*1.5); db[senderId].wallet += payout; saveDB();
                layout += `✨ *MINI WIN!* 2x Match! Gained *+$${payout.toLocaleString()}*!`;
            } else {
                db[senderId].wallet -= bet; saveDB();
                layout += `❌ *LOST!* Deducted *-$${bet.toLocaleString()}*`;
            }
            return msg.reply(layout);
        }

        // ── .roulette ─────────────────────────────────────────────────────────
        if (command === '.roulette') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastRoulette) / 1000 < CD_ROULETTE) {
                let left = Math.ceil(CD_ROULETTE - (now - db[senderId].lastRoulette) / 1000);
                return msg.reply(`⏳ Wheel spinning. Wait *${left}s*.`);
            }
            let space = args[1] ? args[1].toLowerCase() : '';
            let bet = parseInt(args[2]);
            if (!['red','black','green'].includes(space) || isNaN(bet) || bet <= 0 || bet > db[senderId].wallet)
                return msg.reply('❌ Format: `.roulette [red/black/green] [bet]`');
            db[senderId].lastRoulette = now;
            let rollNum = Math.floor(Math.random() * 37);
            // Weighted color determination: red/black 52% each when bet on them, green stays rare
            let landedColor;
            if (rollNum === 0) {
                landedColor = 'green';
            } else {
                const redNums = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
                const isRed = redNums.includes(rollNum);
                // If player bet red/black, give slight house-favor boost (52% win)
                if (space === 'red' || space === 'black') {
                    const playerWins = Math.random() < 0.52;
                    landedColor = playerWins ? space : (space === 'red' ? 'black' : 'red');
                } else {
                    landedColor = isRed ? 'red' : 'black';
                }
            }
            let rouletteText = `🎡 *ROULETTE BOARD* 🎡\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\nResult: *${landedColor.toUpperCase()} (${rollNum})*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            if (space === landedColor) {
                let prize = space === 'green' ? bet * 14 : bet;
                db[senderId].wallet += prize; saveDB();
                rouletteText += `🟢 *WINNER!* You won: *+$${prize.toLocaleString()}*`;
            } else {
                db[senderId].wallet -= bet; saveDB();
                rouletteText += `🔴 *HOUSE WINS!* Lost: *-$${bet.toLocaleString()}*`;
            }
            return msg.reply(rouletteText);
        }

        // ── .db / .double ─────────────────────────────────────────────────────
        if (command === '.db' || command === '.double') {
            initUser(senderId); checkDailyReset(senderId);
            if (db[senderId].dailyDbCount >= 15) return msg.reply('⚖️ Daily cap reached! Max 15/day.');
            const now = Date.now();
            if ((now - db[senderId].lastDb) / 1000 < CD_DB) {
                let left = Math.ceil(CD_DB - (now - db[senderId].lastDb) / 1000);
                return msg.reply(`⏳ Wait *${left}s*.`);
            }
            let bet = parseInt(args[1]);
            if (isNaN(bet) || bet <= 0 || bet > db[senderId].wallet) return msg.reply('❌ Invalid bet.');
            db[senderId].lastDb = now; db[senderId].dailyDbCount += 1;
            if (Math.random() * 100 < 50) {
                db[senderId].wallet += bet; saveDB();
                return msg.reply(`🟢 *DOUBLE SUCCESS!* +$${bet.toLocaleString()} [${db[senderId].dailyDbCount}/15]`);
            } else {
                db[senderId].wallet -= bet; saveDB();
                return msg.reply(`🔴 *CRASHED!* -$${bet.toLocaleString()} [${db[senderId].dailyDbCount}/15]`);
            }
        }

        // ── .cf / .coinflip ───────────────────────────────────────────────────
        if (command === '.cf' || command === '.coinflip') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastCoinflip) / 1000 < CD_COINFLIP) {
                let left = Math.ceil(CD_COINFLIP - (now - db[senderId].lastCoinflip) / 1000);
                return msg.reply(`⏳ Wait *${left}s*.`);
            }
            let userChoice = args[1] ? args[1].toLowerCase() : '';
            let bet = parseInt(args[2]);
            if (!['h','t','heads','tails'].includes(userChoice) || isNaN(bet) || bet <= 0 || bet > db[senderId].wallet)
                return msg.reply('❌ Syntax: `.cf [heads/tails] [bet]`');
            db[senderId].lastCoinflip = now;
            let choiceMap = { h:'heads', t:'tails', heads:'heads', tails:'tails' };
            let pick = choiceMap[userChoice];
            let spin = Math.random() < 0.53 ? pick : (pick === 'heads' ? 'tails' : 'heads');
            let coinEmoji = spin === 'heads' ? '🪙 (Heads)' : '📀 (Tails)';
            let layout = `🪙 *COINFLIP* 🪙\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\nLanded: *${coinEmoji}*\nYour Call: *${pick.toUpperCase()}*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            if (pick === spin) {
                db[senderId].wallet += bet; saveDB();
                layout += `🟢 *VICTORY!* +$${bet.toLocaleString()}\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}`;
            } else {
                db[senderId].wallet -= bet; saveDB();
                layout += `🔴 *DEFEAT!* -$${bet.toLocaleString()}\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}`;
            }
            return msg.reply(layout);
        }

        // ── .deposit / .withdraw ──────────────────────────────────────────────
        if (command === '.deposit' || command === '.dep') {
            initUser(senderId);
            if (db[senderId].wallet <= 0) return msg.reply('❌ Nothing to deposit.');
            let s = args[1]; let amt = (!s || s.toLowerCase() === 'all') ? db[senderId].wallet : parseInt(s);
            if (isNaN(amt) || amt <= 0 || amt > db[senderId].wallet) return msg.reply('❌ Invalid amount.');
            db[senderId].wallet -= amt; db[senderId].bank += amt; saveDB();
            return msg.reply(`🏦 *Deposited:* $${amt.toLocaleString()}\n🏦 Bank: $${db[senderId].bank.toLocaleString()}`);
        }

        if (command === '.withdraw' || command === '.wd') {
            initUser(senderId); let s = args[1];
            if (!s) return msg.reply('❌ Enter amount to withdraw.');
            let amt = s.toLowerCase() === 'all' ? db[senderId].bank : parseInt(s);
            if (isNaN(amt) || amt <= 0 || amt > db[senderId].bank) return msg.reply("❌ You don't have that in bank.");
            db[senderId].bank -= amt; db[senderId].wallet += amt; saveDB();
            return msg.reply(`📊 *Withdrew:* $${amt.toLocaleString()}\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}`);
        }

        // ── .health ───────────────────────────────────────────────────────────
        if (command === '.health') {
            initUser(senderId);
            let party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ No Pokémon! Catch one with *.catch* in a group.');
            let p = party[0];
            if (!p.maxHp) { let lk = WILD_POKEMON_POOL.find(w => w.name.toLowerCase() === p.name.toLowerCase()) || { hp: 50, atk: 50 }; p.maxHp = lk.hp; p.hp = lk.hp; saveDB(); }
            let toxic = isToxic(senderId, p.name);
            let healthCard = `🩺 *PARTNER DIAGNOSTICS* 🩺\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                             `🔰 *Active:* *${p.emoji} ${p.name}*\n` +
                             `🌟 *Level:* Rank ${p.level || 1}\n` +
                             `${p.gender ? `⚤ *Gender:* ${p.gender}\n` : ''}` +
                             `🏷️ *Category:* ${p.category || p.tier || 'Unknown'}\n` +
                             `⚔️ *Attack:* ${p.atk} ATK\n` +
                             `❤️ *HP:* ${p.hp} / ${p.maxHp}\n` +
                             `📊 [ ${makeProgressBar(p.hp, p.maxHp)} ]\n` +
                             `${toxic ? '☠️ *STATUS: TOXIC!* (temp debuff active)\n' : ''}` +
                             `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
            try {
                let media = await MessageMedia.fromUrl(`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${p.dexId || 1}.png`);
                return chatObj.sendMessage(media, { caption: healthCard });
            } catch (_) { return msg.reply(healthCard); }
        }

        // ── .use ──────────────────────────────────────────────────────────────
        if (command === '.use') {
            initUser(senderId);
            let party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ No Pokémon in roster! Catch one first.');
            let name = args.slice(1).join(' ').trim().toLowerCase();
            if (!name) return msg.reply('❌ Syntax: `.use [pokemon_name]`');
            let idx = party.findIndex(p => p.name.toLowerCase() === name);
            if (idx === -1) return msg.reply(`❌ You don't own *${name}*. Check \`.inv\`.`);
            if (idx === 0) return msg.reply(`⚡ *${party[0].name}* is already your active partner!`);
            let chosen = party.splice(idx, 1)[0];
            party.unshift(chosen); saveDB();
            return chatObj.sendMessage(
                `🔄 *SQUAD UPDATED!*\n🟢 *Deployed:* ${chosen.emoji} *${chosen.name}* [Lv.${chosen.level||1}]\n❤️ HP: ${makeProgressBar(chosen.hp, chosen.maxHp||50)} (${chosen.hp}/${chosen.maxHp||50})`,
                { mentions: [senderId] }
            ).catch(() => {});
        }

        // ── .transfer ─────────────────────────────────────────────────────────
        if (command === '.transfer') {
            initUser(senderId);
            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : msg.mentionedIds[0];
            if (!target) return msg.reply('❌ Tag someone or reply to their message.');
            if (target === senderId) return msg.reply('❌ Cannot transfer to yourself.');
            let amtStr = ''; let allFlag = false;
            for (let i = 1; i < args.length; i++) {
                if (args[i].toLowerCase() === 'all') { allFlag = true; break; }
                let clean = args[i].replace(/[^0-9]/g,'');
                if (clean && !args[i].includes('@')) { amtStr = clean; break; }
            }
            let amt = allFlag ? db[senderId].wallet : parseInt(amtStr);
            if (isNaN(amt) || amt <= 0) return msg.reply('❌ Usage: `.transfer [amount] [@tag]`');
            if (amt > db[senderId].wallet) return msg.reply(`❌ You only have *$${db[senderId].wallet.toLocaleString()}*.`);
            initUser(target);
            db[senderId].wallet -= amt; db[target].wallet += amt; saveDB();
            const txnId = 'TXN-' + Math.floor(100000 + Math.random() * 900000) + 'X';
            const receipt = `⚡ *RESERVE BANK WIRE TRANSFER* ⚡\n` +
                            `•———————————•———————————•\n` +
                            `   🏷️ *STATUS:* [ SUCCESS ✅ ]\n` +
                            `•———————————•———————————•\n\n` +
                            `📤 *Sender:* ${senderId.split('@')[0]}\n` +
                            `📥 *Receiver:* ${target.split('@')[0]}\n\n` +
                            `💵 *Amount:* 〔 $${amt.toLocaleString()} 〕\n` +
                            `🧾 *Reference ID:* \`${txnId}\`\n\n` +
                            `•———————————•———————————•\n` +
                            `👛 *Your Balance:* $${db[senderId].wallet.toLocaleString()}\n` +
                            `•———————————•———————————•`;
            // Send as plain message (no @tag mentions as requested)
            return chatObj.sendMessage(receipt).catch(() => {});
        }

        // ── .rob ──────────────────────────────────────────────────────────────
        if (command === '.rob') {
            initUser(senderId);
            if (!isGroupChat) return msg.reply('❌ Robberies only in group chats!');
            const now = Date.now();
            if ((now - db[senderId].lastRob) / 1000 < CD_ROB) {
                let left = Math.ceil(CD_ROB - (now - db[senderId].lastRob) / 1000);
                return msg.reply(`🚔 Lay low for *${Math.floor(left/60)}m ${left%60}s*.`);
            }
            let targetId = msg.mentionedIds[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Tag someone: `.rob @username`');
            if (targetId === senderId) return msg.reply('🤡 Robbing yourself? No.');
            initUser(targetId);
            if (db[targetId].wallet < 1000) return msg.reply(`❌ Target is too broke to rob!`);
            if (db[senderId].wallet < 500) return msg.reply('❌ Need at least *$500* to fund a heist.');
            db[senderId].lastRob = now;

            // Check if target has a heist kit
            const kitKey = db[targetId].activeHeistKit;
            const kit = kitKey ? HEIST_KITS[kitKey] : null;

            if (kit && kit.tier === 3) {
                // VAULT — 100% block, always counter-fine
                const fine = Math.max(1000, Math.floor(db[senderId].wallet * kit.counterPct));
                db[senderId].wallet = Math.max(0, db[senderId].wallet - fine);
                db[targetId].wallet += fine; saveDB();
                return chatObj.sendMessage(
                    `💎 *VAULT PROTOCOL ACTIVATED!* 💎\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `🚫 <@${senderId}> tried to rob <@${targetId}>!\n\n` +
                    `🔐 *${kit.name}* blocked the robbery completely!\n` +
                    `⚡ Auto-counter triggered!\n` +
                    `💸 Robber fined: *-$${fine.toLocaleString()}* → paid to victim!\n\n` +
                    `👛 <@${senderId}> wallet: $${db[senderId].wallet.toLocaleString()}\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_"Nobody touches the Vault."_ 😤`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            }

            const roll = Math.random() * 100;
            if (roll <= 40) {
                const pct = Math.random() * 0.25 + 0.05;
                let rawStolen = Math.max(500, Math.min(Math.floor(db[targetId].wallet * pct), db[targetId].wallet));
                if (kit) {
                    // Partial protection
                    let blocked = Math.floor(rawStolen * kit.protectPct);
                    let stolen  = rawStolen - blocked;
                    db[targetId].wallet -= stolen; db[senderId].wallet += stolen;
                    let robMsg = `🛡️ *HEIST PARTIALLY BLOCKED!* 🛡️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                        `🦹 <@${senderId}> robbed <@${targetId}>!\n` +
                        `🔐 *${kit.name}* was active!\n\n` +
                        `💰 Raw theft: $${rawStolen.toLocaleString()}\n` +
                        `🛡️ Blocked: *$${blocked.toLocaleString()}* (${Math.floor(kit.protectPct*100)}%)\n` +
                        `💸 Stolen: *$${stolen.toLocaleString()}*\n`;
                    if (Math.random() < kit.counterChance) {
                        const fine = Math.max(500, Math.floor(db[senderId].wallet * kit.counterPct));
                        db[senderId].wallet = Math.max(0, db[senderId].wallet - fine);
                        db[targetId].wallet += fine;
                        robMsg += `\n⚡ *Counter triggered!* Robber fined *-$${fine.toLocaleString()}*!\n`;
                    }
                    saveDB();
                    robMsg += `\n👛 <@${targetId}> balance: $${db[targetId].wallet.toLocaleString()}\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
                    return chatObj.sendMessage(robMsg, { mentions: [senderId, targetId] }).catch(() => {});
                } else {
                    db[targetId].wallet -= rawStolen; db[senderId].wallet += rawStolen; saveDB();
                    return chatObj.sendMessage(
                        `🦹 *HEIST SUCCESS!* 🦹\n<@${senderId}> robbed <@${targetId}>!\n💰 Stolen: *+$${rawStolen.toLocaleString()}*\n👛 Your Wallet: $${db[senderId].wallet.toLocaleString()}`,
                        { mentions: [senderId, targetId] }
                    ).catch(() => {});
                }
            } else if (roll <= 80) {
                let fine = Math.max(500, Math.min(Math.floor(db[senderId].wallet * 0.15), db[senderId].wallet));
                db[senderId].wallet -= fine; saveDB();
                return chatObj.sendMessage(
                    `🚔 *CAUGHT!* <@${senderId}> tried to rob <@${targetId}>!` +
                    (kit ? `\n🛡️ *${kit.name}* alerted authorities!` : '') +
                    `\n💸 Fine: *-$${fine.toLocaleString()}*`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            } else {
                saveDB();
                return chatObj.sendMessage(
                    `🏃 <@${senderId}> attempted a robbery on <@${targetId}> but escaped with nothing!`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            }
        }

        // ── .sell ─────────────────────────────────────────────────────────────
        if (command === '.sell') {
            initUser(senderId);
            const item = args[1] ? args[1].toLowerCase() : '';
            const inv = db[senderId].inventory;

            // Card selling: .sell [number] [price]
            if (!isNaN(parseInt(item)) && args[2] && !isNaN(parseInt(args[2]))) {
                const cardIdx = parseInt(item) - 1;
                const price   = parseInt(args[2]);
                const cards   = db[senderId].cardInventory || [];
                if (cardIdx < 0 || cardIdx >= cards.length) return msg.reply(`❌ Invalid card number! You have ${cards.length} card(s). Use \`.cards\` to see them.`);
                if (price <= 0) return msg.reply('❌ Price must be greater than 0!');
                const card = cards[cardIdx];
                let targetId = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
                if (!targetId) return msg.reply('❌ Tag the buyer or reply to their message!\nUsage: `.sell [card no.] [price] @buyer`');
                if (targetId === senderId) return msg.reply('❌ Cannot sell to yourself!');
                initUser(targetId);
                pendingCardTrades[targetId] = { sellerId: senderId, cardIdx, cardData: card, price };
                return chatObj.sendMessage(
                    `🃏 *CARD TRADE OFFER!* 🃏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `📤 *Seller:* <@${senderId}>\n` +
                    `📥 *Buyer:* <@${targetId}>\n\n` +
                    `🃏 *Card:* ${card.emoji} *${card.name}*\n` +
                    `🎌 *Anime:* ${card.anime}\n` +
                    `${TIER_EMOJI[card.tier]} *Tier:* ${card.tier} — ${TIER_NAMES[card.tier]}\n\n` +
                    `💰 *Asking Price:* $${price.toLocaleString()}\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `<@${targetId}> — Do you accept this card trade?\n` +
                    `✅ Type *.accept* to confirm | ❌ Type *.reject* to decline`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            }

            // Fish selling
            if (!item) {
                return msg.reply(
                    `🐟 *MARITIME MARKET*\n• \`.sell fish\` — $200 each\n• \`.sell salmon\` — $800 each\n• \`.sell goldenfish\` — $5,000 each\n• \`.sell all\` — Sell everything\n\n` +
                    `📦 Stock: 🐟 x${inv.fish||0} | 🐟 x${inv.salmon||0} | ✨🐟 x${inv.goldenFish||0}\n\n` +
                    `🃏 *To sell a card:* \`.sell [card no.] [price] @buyer\``
                );
            }
            if (item === 'all') {
                let total = 0; let breakdown = '';
                for (let c of [{key:'fish',price:200,name:'Minnow',emoji:'🐟'},{key:'salmon',price:800,name:'Salmon',emoji:'🐟'},{key:'goldenFish',price:5000,name:'Golden Fish',emoji:'✨🐟'}]) {
                    const qty = inv[c.key] || 0;
                    if (qty > 0) { total += qty * c.price; breakdown += `${c.emoji} x${qty} ➔ +$${(qty*c.price).toLocaleString()}\n`; inv[c.key] = 0; }
                }
                if (total === 0) return msg.reply('❌ Fish inventory empty! Go `.fish` first.');
                db[senderId].wallet += total; saveDB();
                return msg.reply(`🐟 *BULK SALE*\n${breakdown}\n💰 Total: *+$${total.toLocaleString()}*\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}`);
            }
            const entry = FISH_SELL_PRICES[item];
            if (!entry) return msg.reply('❌ Unknown item. Try `.sell fish`, `.sell salmon`, `.sell goldenfish`, or `.sell [card no.] [price] @buyer`.');
            const qty = inv[entry.key] || 0;
            if (qty === 0) return msg.reply(`❌ No ${entry.name} to sell. Go \`.fish\` first.`);
            const earned = qty * entry.price; inv[entry.key] = 0; db[senderId].wallet += earned; saveDB();
            return msg.reply(`🐟 Sold *${qty}x ${entry.name}* for *+$${earned.toLocaleString()}*!\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}`);
        }

        // ── .daily ────────────────────────────────────────────────────────────
        if (command === '.daily') {
            initUser(senderId); const now = Date.now();
            const oneDay = 86400000; const twoDays = 172800000;
            if (db[senderId].lastDaily && (now - db[senderId].lastDaily) < oneDay) {
                let rem = oneDay - (now - db[senderId].lastDaily);
                let h = Math.floor(rem / 3600000); let m = Math.floor((rem % 3600000) / 60000);
                return msg.reply(`⏳ Daily claimed! Come back in *${h}h ${m}m*.\n🔥 Streak: *${db[senderId].dailyStreak} days*`);
            }
            if (db[senderId].lastDaily && (now - db[senderId].lastDaily) < twoDays) {
                db[senderId].dailyStreak = (db[senderId].dailyStreak || 0) + 1;
            } else { db[senderId].dailyStreak = 1; }
            const streak = db[senderId].dailyStreak;
            const base = Math.floor(Math.random() * 45000) + 5000;
            const bonus = (streak - 1) * 2500;
            const total = base + bonus;
            const balls = streak >= 7 ? 5 : streak >= 3 ? 3 : 2;
            db[senderId].lastDaily = now; db[senderId].wallet += total;
            db[senderId].inventory.pokeball = (db[senderId].inventory.pokeball || 0) + balls; saveDB();
            const streakEmoji = streak >= 30 ? '🏆' : streak >= 14 ? '🔥' : streak >= 7 ? '⭐' : '✅';
            return msg.reply(
                `🎁 *DAILY REWARD UNLOCKED!* 🎁\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `${streakEmoji} *Streak:* ${streak} day${streak>1?'s':''}\n` +
                `💵 Base: *+$${base.toLocaleString()}*\n⭐ Streak Bonus: *+$${bonus.toLocaleString()}*\n🔴 Free Pokéballs: *+${balls}*\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n💰 *Total: +$${total.toLocaleString()}*\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}`
            );
        }

        // ── .shop ─────────────────────────────────────────────────────────────
        if (command === '.shop') {
            initUser(senderId);
            const p1 = args[1] ? args[1].toLowerCase() : '';
            const p2 = args[2] ? args[2].toLowerCase() : '';

            if (p1 === 'balls' || p1 === 'pokeballs') {
                let menu = `🔴 *POKÉBALL SHOP* 🔴\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
                for (let key in POKEBALL_SHOP) {
                    const b = POKEBALL_SHOP[key];
                    menu += `${b.emoji} *${b.name}* — $${b.price.toLocaleString()} (\`.buy ${key}\`)\n📝 ${b.desc}\n\n`;
                }
                return msg.reply(menu);
            }
            if (p1 === 'food' || (p1 === 'pokemon' && p2 === 'food')) {
                let menu = `🍗 *POKÉMON FOOD SHOP* 🍗\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
                for (let key in FOOD_SHOP) {
                    const f = FOOD_SHOP[key];
                    menu += `${f.emoji} *${f.name}* — $${f.price.toLocaleString()} (\`.buy ${key}\`)\n📝 ${f.desc}\n\n`;
                }
                return msg.reply(menu);
            }
            // Main shop menu (no pokemon buying store)
            return msg.reply(
                `🛒 *SHOP MENU* 🛒\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `🔴 \`.shop balls\` — Pokéball store\n` +
                `🍗 \`.shop food\` — Pokémon food & items\n\n` +
                `💡 To buy anything: \`.buy [item_name]\`\n` +
                `_Pokémon can only be obtained by catching wild ones!_ 🌿`
            );
        }

        // ── .buy ──────────────────────────────────────────────────────────────
        if (command === '.buy') {
            initUser(senderId);
            let itemKey = args[1] ? args[1].toLowerCase() : '';
            if (!itemKey) return msg.reply('❌ Usage: `.buy [item_name]`');

            if (FOOD_SHOP[itemKey]) {
                let prod = FOOD_SHOP[itemKey];
                if (db[senderId].wallet < prod.price) return msg.reply(`❌ Not enough cash! Price: $${prod.price.toLocaleString()}`);
                db[senderId].wallet -= prod.price;
                db[senderId].inventory[itemKey] = (db[senderId].inventory[itemKey] || 0) + 1; saveDB();
                return msg.reply(`🛍️ Purchased 1x ${prod.emoji} *${prod.name}*! Check \`.inv\`.`);
            }
            if (POKEBALL_SHOP[itemKey]) {
                let ball = POKEBALL_SHOP[itemKey];
                if (db[senderId].wallet < ball.price) return msg.reply(`❌ Not enough cash! Price: $${ball.price.toLocaleString()}`);
                db[senderId].wallet -= ball.price;
                db[senderId].inventory[itemKey] = (db[senderId].inventory[itemKey] || 0) + 1; saveDB();
                return msg.reply(`🛍️ Purchased 1x ${ball.emoji} *${ball.name}*! Check \`.inv\`.`);
            }
            return msg.reply('❌ Item not found! Check \`.shop\` for available items.');
        }

        // ── .feed ─────────────────────────────────────────────────────────────
        // Usage: .feed | .feed pikachu | .feed pikachu coke
        if (command === '.feed') {
            initUser(senderId);
            let party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ No Pokémon! Catch one in a group first.');

            let targetPoke = null;
            let foodKey = null;

            if (args.length === 1) {
                // .feed — auto-feed active Pokémon with first available food
                targetPoke = party[0];
                const inv = db[senderId].inventory;
                for (let key of Object.keys(FOOD_SHOP)) {
                    if (inv[key] && inv[key] > 0) { foodKey = key; break; }
                }
                if (!foodKey) return msg.reply('❌ No food in inventory! Buy some with \`.buy [food]\`.Use \`.shop food\` to see options.');
            } else if (args.length === 2) {
                // .feed pikachu — feed active (or named) Pokémon with first available food
                const possiblePoke = args[1].toLowerCase();
                const foundPoke = party.find(p => p.name.toLowerCase() === possiblePoke);
                if (foundPoke) {
                    targetPoke = foundPoke;
                    const inv = db[senderId].inventory;
                    for (let key of Object.keys(FOOD_SHOP)) {
                        if (inv[key] && inv[key] > 0) { foodKey = key; break; }
                    }
                    if (!foodKey) return msg.reply('❌ No food in inventory! Buy some with \`.buy [food]\`.Use \`.shop food\` to see what\'s available.');
                } else {
                    // Maybe it's .feed coke (feed active Pokémon with specific food)
                    foodKey = possiblePoke;
                    targetPoke = party[0];
                    if (!FOOD_SHOP[foodKey]) return msg.reply(`❌ No Pokémon named "${args[1]}" or food named "${args[1]}" found.`);
                }
            } else {
                // .feed pikachu coke
                const pokeName = args.slice(1, args.length - 1).join(' ').toLowerCase();
                foodKey = args[args.length - 1].toLowerCase();
                targetPoke = party.find(p => p.name.toLowerCase() === pokeName);
                if (!targetPoke) return msg.reply(`❌ No Pokémon named "${pokeName}" in your roster. Check \`.inv\`.`);
                if (!FOOD_SHOP[foodKey]) return msg.reply(`❌ Unknown food "${foodKey}". Check \`.shop food\`.`);
            }

            const food = FOOD_SHOP[foodKey];
            const inv = db[senderId].inventory;
            if (!inv[foodKey] || inv[foodKey] <= 0) return msg.reply(`❌ Out of *${food.name}*! Buy with \`.buy ${foodKey}\`.`);

            // Fix maxHp if missing
            if (!targetPoke.maxHp || targetPoke.maxHp === 'undefined') {
                let lk = WILD_POKEMON_POOL.find(w => w.name.toLowerCase() === targetPoke.name.toLowerCase()) || { hp: 50, atk: 50 };
                targetPoke.maxHp = lk.hp; targetPoke.hp = lk.hp;
            }
            if (!targetPoke.atk) {
                let lk = WILD_POKEMON_POOL.find(w => w.name.toLowerCase() === targetPoke.name.toLowerCase()) || { atk: 50 };
                targetPoke.atk = lk.atk;
            }

            // Refuse if HP already full (for regular food)
            if (foodKey !== 'mrbeast' && targetPoke.hp >= targetPoke.maxHp && !food.isAlcohol) {
                return msg.reply(`🍽️ *${targetPoke.emoji} ${targetPoke.name}* is already at full health and refuses to eat!\n❤️ HP: ${targetPoke.hp}/${targetPoke.maxHp} — already full!`);
            }

            const pokeName = targetPoke.name.toLowerCase();

            // ── Alcohol/Toxic handling ────────────────────────────────────────
            if (food.isAlcohol) {
                if (!db[senderId].toxicity[pokeName]) db[senderId].toxicity[pokeName] = { alcoholCount: 0, cigarCount: 0, toxicUntil: 0 };
                const tox = db[senderId].toxicity[pokeName];

                // Check if already toxic
                if (isToxic(senderId, pokeName)) {
                    const rem = Math.ceil((tox.toxicUntil - Date.now()) / 60000);
                    return msg.reply(`☠️ *${targetPoke.emoji} ${targetPoke.name}* is already *INTOXICATED* and refuses anything else!\n⏳ Toxic wears off in *${rem} min*.`);
                }

                const isCigar = foodKey === 'cigar' || foodKey === 'cigarette';
                if (isCigar) tox.cigarCount = (tox.cigarCount || 0) + 1;
                else tox.alcoholCount = (tox.alcoholCount || 0) + 1;
                const count = isCigar ? tox.cigarCount : tox.alcoholCount;
                const label = isCigar ? 'smokes' : 'drinks';

                inv[foodKey] -= 1;
                let result = '';

                if (count <= 3) {
                    // Beneficial: heal + ATK buff
                    const oldHp = targetPoke.hp;
                    targetPoke.hp = Math.min(targetPoke.maxHp, targetPoke.hp + food.heal);
                    db[senderId].atkBuff = (db[senderId].atkBuff || 0) + (food.atkBuff || 0);
                    saveDB();
                    result = `${food.emoji} *${targetPoke.name}* had ${food.name}! (${label} #${count}/3)\n` +
                             `❤️ HP: ${oldHp} ➔ *${targetPoke.hp}/${targetPoke.maxHp}*\n` +
                             `⚔️ Temp ATK Buff: *+${food.atkBuff}* for next battle!\n` +
                             `⚠️ _(3 uses max — after that it gets toxic!)_`;
                } else {
                    // Toxic! Set toxicity timer
                    const toxDurations = { rum: 10, whiskey: 12, cigar: 10, cigarette: 15, beer: 10 };
                    const toxMins = toxDurations[foodKey] || 10;
                    tox.toxicUntil = Date.now() + toxMins * 60000;
                    // Penalize: remove ATK buff + reduce HP
                    const dmg = Math.floor(targetPoke.maxHp * 0.2);
                    targetPoke.hp = Math.max(1, targetPoke.hp - dmg);
                    db[senderId].atkBuff = 0;
                    saveDB();
                    result = `☠️ *OVERDOSE!* *${targetPoke.name}* consumed too much ${food.emoji}!\n` +
                             `🤢 It's now *TOXIC* for the next *${toxMins} minutes*!\n` +
                             `📉 HP dropped by ${dmg}! Now: *${targetPoke.hp}/${targetPoke.maxHp}*\n` +
                             `⚔️ All ATK buffs removed!\n` +
                             `💊 _Wait for detox or use \`.buy protein\` to help recovery._`;
                }
                return msg.reply(result);
            }

            // ── Normal food ───────────────────────────────────────────────────
            inv[foodKey] -= 1;
            const initHp = targetPoke.hp;
            const initMaxHp = targetPoke.maxHp;
            const initAtk = targetPoke.atk;

            if (foodKey === 'mrbeast') {
                // Check daily limit: 5 per pokemon per day
                const pnLow = targetPoke.name.toLowerCase();
                if (!db[senderId].mrbeastDaily) db[senderId].mrbeastDaily = {};
                const mbData = db[senderId].mrbeastDaily[pnLow] || { count: 0, lastReset: 0 };
                const now = Date.now();
                if (now - mbData.lastReset > 86400000) { mbData.count = 0; mbData.lastReset = now; }
                if (mbData.count >= 5) {
                    inv[foodKey] += 1; // refund
                    return msg.reply(`❌ *${targetPoke.emoji} ${targetPoke.name}* has already had 5 MrBeast Chocolates today! Come back tomorrow. 🍫`);
                }
                mbData.count += 1;
                db[senderId].mrbeastDaily[pnLow] = mbData;
                targetPoke.maxHp += 50; targetPoke.atk += 25; targetPoke.hp = targetPoke.maxHp; saveDB();
                return msg.reply(
                    `✨ *MRBEAST UPGRADE!* ✨\n*${targetPoke.emoji} ${targetPoke.name}* consumed the $10M Chocolate! (${mbData.count}/5 today)\n` +
                    `❤️ Max HP: ${initMaxHp} ➔ *${targetPoke.maxHp}* (+50 forever)\n` +
                    `🗡️ Attack: ${initAtk} ➔ *${targetPoke.atk}* (+25 forever)\n💚 Fully healed!`
                );
            }

            // sushi XP bonus
            if (foodKey === 'sushi' && food.xpBonus) {
                targetPoke.xp = (targetPoke.xp || 0) + food.xpBonus;
                if (targetPoke.xp >= (targetPoke.maxXp || 100)) { targetPoke.level = (targetPoke.level || 1) + 1; targetPoke.xp = 0; }
            }
            // energy ATK buff
            if (foodKey === 'energy' && food.atkBuff) {
                db[senderId].atkBuff = (db[senderId].atkBuff || 0) + food.atkBuff;
            }
            // mystery XP
            if (foodKey === 'mystery') {
                targetPoke.xp = (targetPoke.xp || 0) + 20;
                if (targetPoke.xp >= (targetPoke.maxXp || 100)) { targetPoke.level = (targetPoke.level || 1) + 1; targetPoke.xp = 0; }
            }

            // ── Permanent ATK boost from food (scales with food price) ─────────
            const atkGain = food.atkBoost || 0;
            if (atkGain > 0) {
                targetPoke.atk = (targetPoke.atk || 50) + atkGain;
            }

            targetPoke.hp = food.energy === 100 ? targetPoke.maxHp : Math.min(targetPoke.maxHp, initHp + food.heal);
            saveDB();
            return msg.reply(
                `🐾 Fed 1x ${food.emoji} *${food.name}* to *${targetPoke.emoji} ${targetPoke.name}*!\n` +
                `❤️ HP: ${initHp}/${targetPoke.maxHp} ➔ *${targetPoke.hp}/${targetPoke.maxHp}*` +
                (atkGain > 0 ? `\n⚔️ ATK: ${initAtk} ➔ *${targetPoke.atk}* (+${atkGain})` : '') +
                (food.xpBonus ? `\n⭐ +${food.xpBonus} XP!` : '') +
                (food.atkBuff && foodKey === 'energy' ? `\n⚡ +${food.atkBuff} temp ATK buff for next battle!` : '')
            );
        }

        // ── .inv ──────────────────────────────────────────────────────────────
        if (command === '.inv' || command === '.inventory') {
            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : (msg.mentionedIds[0] || senderId);
            initUser(target);
            const inv = db[target].inventory; const party = db[target].pokemon || [];
            let msgText = `🎒 *<@${target}>'s Inventory* 📦\n` +
                          `💼 Bag: ${inv.assignedBag || 'Basic Sack'}\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                          `🔴 *POKÉBALLS:*\n` +
                          `• 🔴 Pokéball x${inv.pokeball||0} | 🔵 Great Ball x${inv.greatball||0}\n` +
                          `• ⚫ Ultra Ball x${inv.ultraball||0} | 🟣 Master Ball x${inv.masterball||0}\n` +
                          `• ⚙️ Heavy Ball x${inv.heavyball||0} | 🎣 Lure Ball x${inv.lureball||0}\n\n` +
                          `🔧 *TOOLS:* ⛏️ Shovel x${inv.shovel} | 🎣 Fishing Rod x${inv.fishingRod}\n\n` +
                          `🐠 *FISH:* ✨🐟 Golden x${inv.goldenFish||0} | 🐟 Salmon x${inv.salmon||0} | 🐟 Minnow x${inv.fish||0}\n\n` +
                          `🍗 *FOOD:*\n`;
            for (let key of Object.keys(FOOD_SHOP)) {
                const qty = inv[key] || 0;
                if (qty > 0) msgText += `• ${FOOD_SHOP[key].emoji} ${FOOD_SHOP[key].name}: x${qty}\n`;
            }
            msgText += `\n🐾 *POKÉMON ROSTER:*\n`;
            if (party.length === 0) {
                msgText += `_No Pokémon caught yet! Use \`.catch\` in a group._\n`;
            } else {
                party.forEach((p, i) => {
                    if (!p.maxHp) { let lk = WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p.name.toLowerCase())||{hp:50}; p.maxHp=lk.hp; p.hp=lk.hp; }
                    const toxic = isToxic(target, p.name) ? ' ☠️TOXIC' : '';
                    msgText += `${i+1}. ${p.emoji} *${p.name}* ${p.gender||''} Lv.${p.level||1} | ❤️ ${p.hp}/${p.maxHp} | ⚔️ ${p.atk}${toxic}\n`;
                });
                saveDB();
            }
            return chatObj.sendMessage(msgText, { mentions: [target] }).catch(() => {});
        }

        // ── .battle (PvP with moves) ───────────────────────────────────────────
        if (command === '.battle') {
            initUser(senderId);
            if (!isGroupChat) return msg.reply('❌ Battles only in group chats!');
            if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('❌ Tag an opponent: `.battle [@tag]`');
            let targetId = msg.mentionedIds[0];
            if (targetId === senderId) return msg.reply('🤡 Fighting yourself? Seek help.');
            initUser(targetId);

            let p1Party = db[senderId].pokemon || [];
            let p2Party = db[targetId].pokemon || [];
            if (p1Party.length === 0) return msg.reply('❌ You have no Pokémon! Catch one first.');
            if (p2Party.length === 0) return msg.reply('❌ Opponent has no Pokémon!');

            let p1 = p1Party[0]; let p2 = p2Party[0];
            if (!p1.maxHp) { let lk = WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p1.name.toLowerCase())||{hp:50,atk:50}; p1.maxHp=lk.hp; p1.hp=lk.hp; p1.atk=lk.atk; }
            if (!p2.maxHp) { let lk = WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p2.name.toLowerCase())||{hp:50,atk:50}; p2.maxHp=lk.hp; p2.hp=lk.hp; p2.atk=lk.atk; }

            if (p1.hp < 10) return msg.reply(`❌ *${p1.emoji} ${p1.name}* is too weak (${p1.hp} HP)! Feed it first with \`.feed\`.`);
            if (isToxic(senderId, p1.name)) return msg.reply(`❌ *${p1.emoji} ${p1.name}* is TOXIC and can't battle! Wait for detox.`);

            pendingBattles[targetId] = { challengerId: senderId, challengerName: senderId.split('@')[0], defenderName: targetId.split('@')[0] };
            const moves1 = getMovesForPokemon(p1.name);
            let requestTxt = `🏟️ *BATTLE CHALLENGE!* 🏟️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                             `⚔️ <@${senderId}> challenges <@${targetId}>!\n` +
                             `🔴 *${p1.emoji} ${p1.name}* vs 🔵 *${p2.emoji} ${p2.name}*\n\n` +
                             `🟢 Type \`.accept\` to battle | 🔴 Type \`.reject\` to back down.\n` +
                             `_(Challenge expires in 2 min)_`;
            return chatObj.sendMessage(requestTxt, { mentions: [senderId, targetId] }).catch(() => {});
        }

        if (command === '.accept') {
            // Card trade accept takes priority if pending
            if (pendingCardTrades[senderId]) {
                initUser(senderId);
                const trade = pendingCardTrades[senderId];
                delete pendingCardTrades[senderId];
                initUser(trade.sellerId);
                if (db[senderId].wallet < trade.price)
                    return msg.reply(`❌ Not enough funds!\n💰 Need: $${trade.price.toLocaleString()}\n👛 You have: $${db[senderId].wallet.toLocaleString()}`);
                const sellerCards = db[trade.sellerId].cardInventory || [];
                const sIdx = sellerCards.findIndex(c => c.id === trade.cardData.id);
                if (sIdx === -1) return msg.reply('❌ Card no longer available!');
                sellerCards.splice(sIdx, 1);
                db[senderId].wallet -= trade.price;
                db[trade.sellerId].wallet += trade.price;
                db[senderId].cardInventory.push(trade.cardData);
                saveDB();
                return chatObj.sendMessage(
                    `🃏 *CARD TRADE SUCCESSFUL!* 🃏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `${trade.cardData.emoji} *${trade.cardData.name}* transferred!\n` +
                    `📤 <@${trade.sellerId}> received: *+$${trade.price.toLocaleString()}*\n` +
                    `📥 <@${senderId}> received the card!\n\n_Check with \`.cards\`!_`,
                    { mentions: [trade.sellerId, senderId] }
                ).catch(() => {});
            }
            if (!pendingBattles[senderId]) return msg.reply('❌ No battle invitation found for you.');
            const bData = pendingBattles[senderId];
            delete pendingBattles[senderId];

            initUser(bData.challengerId); initUser(senderId);
            let p1 = db[bData.challengerId].pokemon[0];
            let p2 = db[senderId].pokemon[0];
            if (!p1.maxHp) { let lk=WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p1.name.toLowerCase())||{hp:50,atk:50}; p1.maxHp=lk.hp; p1.hp=lk.hp; p1.atk=lk.atk; }
            if (!p2.maxHp) { let lk=WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p2.name.toLowerCase())||{hp:50,atk:50}; p2.maxHp=lk.hp; p2.hp=lk.hp; p2.atk=lk.atk; }

            if (p2.hp < 10) return msg.reply(`❌ *${p2.name}* is too weak! Feed it first.`);
            if (isToxic(senderId, p2.name)) return msg.reply(`❌ *${p2.name}* is TOXIC and can't battle!`);

            // Apply ATK buffs
            const p1AtkBuff = db[bData.challengerId].atkBuff || 0;
            const p2AtkBuff = db[senderId].atkBuff || 0;
            const p1Battle = { ...p1, atk: (p1.atk || 50) + p1AtkBuff };
            const p2Battle = { ...p2, atk: (p2.atk || 50) + p2AtkBuff };
            db[bData.challengerId].atkBuff = 0; db[senderId].atkBuff = 0;

            const battleId = generateBattleId();
            activeBattles[battleId] = { p1: p1Battle, p2: p2Battle, p1Id: bData.challengerId, p2Id: senderId, turn: 'p1', wildMode: false };

            const moves1 = getMovesForPokemon(p1Battle.name);
            let startMsg = `🏟️ *BATTLE BEGINS!* 🏟️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                           `🔴 @${bData.challengerName}: *${p1Battle.emoji} ${p1Battle.name}* ❤️ ${p1Battle.hp}/${p1Battle.maxHp}\n` +
                           `🔵 @${bData.defenderName}: *${p2Battle.emoji} ${p2Battle.name}* ❤️ ${p2Battle.hp}/${p2Battle.maxHp}\n\n` +
                           `⚔️ @${bData.challengerName}'s turn! Choose a move:\n`;
            moves1.forEach((m, i) => { startMsg += `${i+1}. ${m.emoji} *${m.name}* (${m.damage[0]}-${m.damage[1]} dmg)${m.special?' ✨':''}\n`; });
            startMsg += `\nReply with move number or name!`;

            // Auto-timeout battle after 5 minutes
            setTimeout(() => { if (activeBattles[battleId]) { delete activeBattles[battleId]; chatObj.sendMessage(`⏰ *Battle ${battleId} timed out!* No moves made for 5 minutes.`).catch(() => {}); } }, 300000);

            return chatObj.sendMessage(startMsg, { mentions: [bData.challengerId, senderId] }).catch(() => {});
        }

        if (command === '.reject') {
            if (pendingCardTrades[senderId]) {
                const trade = pendingCardTrades[senderId];
                delete pendingCardTrades[senderId];
                return chatObj.sendMessage(
                    `❌ <@${senderId}> *rejected* the card trade from <@${trade.sellerId}>!`,
                    { mentions: [senderId, trade.sellerId] }
                ).catch(() => {});
            }
            if (!pendingBattles[senderId]) return msg.reply('❌ No pending invitations.');
            const bData = pendingBattles[senderId]; delete pendingBattles[senderId];
            return chatObj.sendMessage(`❌ @${bData.defenderName} backed down from the challenge!`, { mentions: [bData.challengerId, senderId] }).catch(() => {});
        }

        // ── .catch (start wild battle) ────────────────────────────────────────
        if (command === '.catch') {
            if (!isGroupChat) return msg.reply('❌ Wild Pokémon only appear in groups!');
            initUser(senderId);
            const cid = chatObj.id._serialized;
            const wildState = wildPokemonState[cid];
            if (!wildState) return msg.reply('❌ No wild Pokémon lurking right now! Wait for one to spawn.');

            const wild = wildState.pokemon;

            // If already weakened — tell them to .throwball
            if (wildState.weakened) {
                return msg.reply(`🎯 *${wild.emoji} ${wild.name}* is already weakened! Use *.throwball [balltype]* to catch it!\n_(e.g. \`.throwball pokeball\`)_`);
            }

            let party = db[senderId].pokemon || [];

            // ── NEW USER FIRST CATCH ─────────────────────────────────────────
            // If player has no Pokémon, let them attempt a direct catch with their starter Pokéball
            if (party.length === 0) {
                const inv = db[senderId].inventory;
                if (!inv.pokeball || inv.pokeball <= 0) {
                    return msg.reply(
                        `🆕 *New Trainer Alert!*\n\n` +
                        `You have no Pokémon yet, but you're out of Pokéballs too! 😢\n` +
                        `Buy one with \`.buy pokeball\` (costs $500) and try again!`
                    );
                }

                // Give them a chance to catch it directly (lower base rate for new users — no battle weakening)
                const rateMap = { Weak: 55, Common: 40, Rare: 25, Epic: 15, Legendary: 5 };
                let catchChance = rateMap[wild.rarity] || 40;
                catchChance = Math.min(catchChance, 100);

                inv.pokeball -= 1;

                // Suspense GIF
                try {
                    const media = await MessageMedia.fromUrl(POKEBALL_GIF_URL);
                    await chatObj.sendMessage(media, {
                        caption: `🆕 *First catch attempt!* <@${senderId}> is a new trainer with no Pokémon!\n\n` +
                                 `🔴 Threw a Pokéball at *${wild.emoji} ${wild.name}*!\n⏳ _The ball wobbles... fingers crossed!_ 🤞`,
                        mentions: [senderId]
                    });
                } catch (_) {
                    await chatObj.sendMessage(
                        `🆕 *First catch attempt!* <@${senderId}> threw a 🔴 Pokéball at *${wild.emoji} ${wild.name}*!\n⏳ _Suspense..._ 🤞`,
                        { mentions: [senderId] }
                    ).catch(() => {});
                }

                await new Promise(r => setTimeout(r, 10000));

                const firstCaught = Math.random() * 100 <= catchChance;
                saveDB();

                if (firstCaught) {
                    delete wildPokemonState[cid];
                    db[senderId].pokemon.push({
                        name: wild.name, tier: wild.rarity, category: wild.category||wild.rarity, level: 1, xp: 0, maxXp: 100,
                        hp: wild.hp, maxHp: wild.hp, atk: wild.atk, emoji: wild.emoji, dexId: wild.dexId,
                        gender: Math.random() > 0.5 ? '♂' : '♀'
                    });
                    saveDB();
                    return chatObj.sendMessage(
                        `🎉 *GOTCHA!* *${wild.emoji} ${wild.name}* [${wild.rarity}] was caught!\n` +
                        `❤️ HP: ${wild.hp} | ⚔️ ATK: ${wild.atk}\n\n` +
                        `🌟 *Welcome to your Pokémon journey, <@${senderId}>!*\n` +
                        `Type \`.inv\` to see your new partner! Now you can battle and catch more! 🏆`,
                        { mentions: [senderId] }
                    ).catch(() => {});
                } else {
                    // 15% chance it flees entirely
                    if (Math.random() < 0.15) {
                        delete wildPokemonState[cid];
                        return chatObj.sendMessage(
                            `💨 *${wild.emoji} ${wild.name}* broke free and *FLED!* So close! 😤\n` +
                            `🔴 Pokéballs remaining: ${inv.pokeball}\n` +
                            `💡 _Wait for another Pokémon to spawn and try again!_`,
                            { mentions: [senderId] }
                        ).catch(() => {});
                    }
                    return chatObj.sendMessage(
                        `❌ *${wild.emoji} ${wild.name}* broke free from the Pokéball!\n` +
                        `🔴 Pokéballs remaining: ${inv.pokeball}\n` +
                        `💡 _The wild Pokémon is still here! Try \`.catch\` again or use \`.throwball pokeball\`!_`,
                        { mentions: [senderId] }
                    ).catch(() => {});
                }
            }
            // ── END NEW USER FIRST CATCH ─────────────────────────────────────

            let myPoke = party[0];
            if (!myPoke.maxHp) { let lk=WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===myPoke.name.toLowerCase())||{hp:50,atk:50}; myPoke.maxHp=lk.hp; myPoke.hp=lk.hp; myPoke.atk=lk.atk; }
            if (myPoke.hp < 5) return msg.reply(`❌ *${myPoke.emoji} ${myPoke.name}* is almost fainted! Feed it first with \`.feed\`.`);
            if (isToxic(senderId, myPoke.name)) return msg.reply(`❌ *${myPoke.emoji} ${myPoke.name}* is TOXIC! It can't battle.`);

            // Set up wild battle
            const wildBattlePoke = { ...wild, hp: wild.hp, maxHp: wild.hp };
            const battleId = generateBattleId();

            activeBattles[battleId] = {
                p1: { ...myPoke },
                p2: wildBattlePoke,
                p1Id: senderId,
                p2Id: 'wild',
                turn: 'p1',
                wildMode: true,
                wildPokemon: wild,
                chatId: cid
            };

            // Remove wild state temporarily (battle in progress)
            delete wildPokemonState[cid];

            const myMoves = getMovesForPokemon(myPoke.name);
            let battleMsg = `⚔️ *WILD BATTLE STARTED!* ⚔️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                            `🔴 *${myPoke.emoji} ${myPoke.name}* ❤️ ${myPoke.hp}/${myPoke.maxHp}\n` +
                            `🟢 *${wild.emoji} ${wild.name}* [${wild.rarity}] ❤️ ${wild.hp}/${wild.hp}\n\n` +
                            `⚔️ <@${senderId}>, choose your move:\n`;
            myMoves.forEach((m, i) => { battleMsg += `${i+1}. ${m.emoji} *${m.name}* (${m.damage[0]}-${m.damage[1]} dmg)${m.special?' ✨':''}\n`; });
            battleMsg += `\nReply with move number or name to attack!`;

            // Auto-counter attack when it's wild's turn — handled in the move handler above
            // Wild auto-attacks after player moves (we need to trigger it)
            // We'll handle wild auto-attack by checking p2Id === 'wild' in the move handler
            return chatObj.sendMessage(battleMsg, { mentions: [senderId] }).catch(() => {});
        }

        // ── .throwball ────────────────────────────────────────────────────────
        if (command === '.throwball') {
            if (!isGroupChat) return msg.reply('❌ Catching only in groups!');
            initUser(senderId);
            const cid = chatObj.id._serialized;
            const wildState = wildPokemonState[cid];
            if (!wildState || !wildState.weakened) return msg.reply('❌ No weakened Pokémon to catch! Battle it first with *.catch*.');

            const wild = wildState.pokemon;
            const ballKey = args[1] ? args[1].toLowerCase() : 'pokeball';
            const ballInfo = POKEBALL_SHOP[ballKey];
            if (!ballInfo) return msg.reply(`❌ Unknown ball type! Options: ${Object.keys(POKEBALL_SHOP).join(', ')}`);

            const inv = db[senderId].inventory;
            if (!inv[ballKey] || inv[ballKey] <= 0) return msg.reply(`❌ No ${ballInfo.emoji} *${ballInfo.name}*! Buy from \`.shop balls\`.`);

            inv[ballKey] -= 1;

            // Suspense message + GIF
            try {
                const media = await MessageMedia.fromUrl(POKEBALL_GIF_URL);
                await chatObj.sendMessage(media, { caption: `🎯 <@${senderId}> threw a ${ballInfo.emoji} *${ballInfo.name}* at *${wild.emoji} ${wild.name}*!\n\n⏳ _The ball wobbles... come on... come on..._ 🤞`, mentions: [senderId] });
            } catch (_) {
                await chatObj.sendMessage(`🎯 <@${senderId}> threw a ${ballInfo.emoji} *${ballInfo.name}* at *${wild.emoji} ${wild.name}*!\n⏳ _Suspense..._ 🤞`, { mentions: [senderId] }).catch(() => {});
            }

            // 10-second suspense
            await new Promise(r => setTimeout(r, 10000));

            // Rarity-based catch rates
            const rateMap = { Weak: 75, Common: 60, Rare: 40, Epic: 25, Legendary: 10 };
            let catchChance = (rateMap[wild.rarity] || 50) + (ballInfo.catchBonus || 0);
            if (ballInfo.catchBonus >= 100) catchChance = 100; // masterball
            catchChance = Math.min(catchChance, 100);

            const caught = Math.random() * 100 <= catchChance;

            if (caught) {
                delete wildPokemonState[cid];
                const alreadyOwns = (db[senderId].pokemon || []).some(p => p.name.toLowerCase() === wild.name.toLowerCase());
                let resultMsg;
                if (alreadyOwns) {
                    const bonus = Math.floor(Math.random() * 30000) + 10000;
                    db[senderId].wallet += bonus; saveDB();
                    resultMsg = `🎉 *CAUGHT!* But you already own *${wild.name}*!\n💰 Released for a bounty: *+$${bonus.toLocaleString()}*!`;
                } else {
                    db[senderId].pokemon = db[senderId].pokemon || [];
                    db[senderId].pokemon.push({
                        name: wild.name, tier: wild.rarity, category: wild.category||wild.rarity, level: 1, xp: 0, maxXp: 100,
                        hp: wild.hp, maxHp: wild.hp, atk: wild.atk, emoji: wild.emoji, dexId: wild.dexId,
                        gender: Math.random() > 0.5 ? '♂' : '♀'
                    });
                    saveDB();
                    resultMsg = `🎉 *GOTCHA!* *${wild.emoji} ${wild.name}* [${wild.rarity}] was caught!\n❤️ HP: ${wild.hp} | ⚔️ ATK: ${wild.atk}\n\n🎊 *Congratulations <@${senderId}>!*\nType \`.inv\` to see your updated roster!`;
                }
                return chatObj.sendMessage(resultMsg, { mentions: [senderId] }).catch(() => {});
            } else {
                // 20% chance it already fled even after being weakened
                if (Math.random() < 0.2) {
                    delete wildPokemonState[cid];
                    return chatObj.sendMessage(`💨 *${wild.emoji} ${wild.name}* shook off the ball and *FLED!* Even after being weakened... unlucky! 😤\n🔴 ${ballInfo.name} used: ${inv[ballKey]+1} ➔ ${inv[ballKey]}`, { mentions: [senderId] }).catch(() => {});
                }
                // Still catchable
                saveDB();
                return chatObj.sendMessage(
                    `❌ *${wild.emoji} ${wild.name}* broke free from the ${ballInfo.emoji} ${ballInfo.name}!\n` +
                    `🔴 ${ballKey} remaining: ${inv[ballKey]}\n` +
                    `💡 Try again with \`.throwball [balltype]\` or use a stronger ball!`,
                    { mentions: [senderId] }
                ).catch(() => {});
            }
        }

        // ── .pp — MOD ONLY: full database profile lookup ──────────────────────
        if (command === '.pp') {
            if (!isMod) return msg.reply('❌ This command is restricted to moderators only.');
            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : (msg.mentionedIds[0] || null);
            if (!target) return msg.reply('❌ Tag someone or reply to their message.\nUsage: `.pp @user`');
            initUser(target);
            const u = db[target];
            const joinedDate = u.joinedAt ? new Date(u.joinedAt).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'Unknown';
            const lastActiveDate = u.lastDaily ? new Date(u.lastDaily).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'Never';
            const lastRobDate = u.lastRob && u.lastRob > 0 ? new Date(u.lastRob).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'Never';
            const lastGambleDate = u.lastCasino && u.lastCasino > 0 ? new Date(u.lastCasino).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'Never';
            const totalGambles = (u.totalCasinoGames || 0) + (u.dailyDbCount || 0);
            const pokemonCount = (u.pokemon || []).length;
            const cardCount = (u.cards || []).length;
            const kitName = u.activeHeistKit ? (HEIST_KITS[u.activeHeistKit]?.name || u.activeHeistKit) : 'None';
            const out =
                `🔍 *[MOD] DATABASE LOOKUP* 🔍\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `🆔 *DB Key (User ID):*\n\`${target}\`\n\n` +
                `👤 *Discord User:* <@${target}>\n` +
                `📅 *First Seen:* ${joinedDate}\n` +
                `🕐 *Last Daily:* ${lastActiveDate}\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `💰 *FINANCIALS*\n` +
                `👛 Wallet: *$${u.wallet.toLocaleString()}*\n` +
                `🏦 Bank: *$${u.bank.toLocaleString()}*\n` +
                `💎 Net Worth: *$${(u.wallet + u.bank).toLocaleString()}*\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🎲 *GAMBLING HISTORY*\n` +
                `🎰 Last Casino: ${lastGambleDate}\n` +
                `🦹 Last Rob: ${lastRobDate}\n` +
                `🎯 DB Games Today: ${u.dailyDbCount || 0}/15\n` +
                `📊 Total Gambles: ~${totalGambles}\n` +
                `🔥 Daily Streak: ${u.dailyStreak || 0} days\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🎮 *GAME ASSETS*\n` +
                `🐾 Pokémon Owned: ${pokemonCount}\n` +
                `🃏 Cards Owned: ${cardCount}\n` +
                `🛡️ Heist Kit: ${kitName}\n` +
                `👜 Bag: ${u.inventory?.assignedBag || 'Basic Sack'}\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `_Use the DB key above to directly edit this user's data._`;
            return msg.reply(out);
        }

        // ── .psell (list a pokemon for sale) ─────────────────────────────────
        if (command === '.psell') {
            if (!isGroupChat) return msg.reply('❌ Groups only!');
            initUser(senderId);
            const psellName = (args[1] || '').toLowerCase();
            const psellPrice = parseInt(args[2]);
            if (!psellName || isNaN(psellPrice) || psellPrice < 100)
                return msg.reply(`❌ Usage: *.psell [pokemon] [price]*\nExample: \`.psell charizard 50000\`\n_Min price: $100_`);
            const psellParty = db[senderId].pokemon || [];
            const psellIdx = psellParty.findIndex(p => p.name.toLowerCase() === psellName);
            if (psellIdx === -1) return msg.reply(`❌ You don't own *${psellName}*! Check \`.inv\`.`);
            const psellPoke = psellParty[psellIdx];
            if (!db._pokemonMarket) db._pokemonMarket = {};
            const existingListing = Object.entries(db._pokemonMarket).find(([,l]) => l.sellerId === senderId);
            if (existingListing) return msg.reply(`❌ You already have *${existingListing[1].pokemon.name}* listed! Use *.pcancelsell* first.`);
            const newListingId = `${senderId}_${Date.now()}`;
            db._pokemonMarket[newListingId] = { sellerId: senderId, pokemon: { ...psellPoke }, price: psellPrice, listedAt: Date.now() };
            saveDB();
            return chatObj.sendMessage(
                `🏪 *POKÉMON FOR SALE!* 🏪\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `${psellPoke.emoji} *${psellPoke.name}* [${psellPoke.tier || 'Unknown'}] Lv.${psellPoke.level || 1}\n` +
                `❤️ HP: ${psellPoke.hp}/${psellPoke.maxHp} | ⚔️ ATK: ${psellPoke.atk}\n` +
                `💰 *Price: $${psellPrice.toLocaleString()}*\n` +
                `👤 Seller: <@${senderId}>\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `📌 *Tag any message by <@${senderId}> and type .pbuy to purchase!*\n` +
                `_(Seller must confirm with *.pyes* or *.pno*)_`,
                { mentions: [senderId] }
            ).catch(() => {});
        }

        // ── .pbuy (buyer replies to seller msg to request purchase) ──────────
        if (command === '.pbuy') {
            if (!isGroupChat) return msg.reply('❌ Groups only!');
            initUser(senderId);
            if (!msg.hasQuotedMsg) return msg.reply(`❌ Reply to any message from the seller and type *.pbuy* to purchase!`);
            const pbuyQuoted = await msg.getQuotedMessage();
            const pbuySellerID = pbuyQuoted.author || pbuyQuoted.from;
            if (pbuySellerID === senderId) return msg.reply('❌ You cannot buy your own Pokémon!');
            if (!db._pokemonMarket) return msg.reply('❌ No Pokémon listed for sale! Check `.market`.');
            const pbuyListings = Object.entries(db._pokemonMarket).filter(([,l]) => l.sellerId === pbuySellerID && !l.pendingBuyerId);
            if (pbuyListings.length === 0) return msg.reply(`❌ <@${pbuySellerID}> has no available Pokémon listing right now.`);
            const [pbuyListId, pbuyListing] = pbuyListings[0];
            initUser(pbuySellerID);
            if (db[senderId].wallet < pbuyListing.price)
                return msg.reply(`❌ You need *$${pbuyListing.price.toLocaleString()}* but only have *$${db[senderId].wallet.toLocaleString()}*!`);
            db._pokemonMarket[pbuyListId].pendingBuyerId = senderId;
            db._pokemonMarket[pbuyListId].pendingAt = Date.now();
            saveDB();
            setTimeout(() => {
                if (db._pokemonMarket?.[pbuyListId]?.pendingBuyerId === senderId) {
                    delete db._pokemonMarket[pbuyListId].pendingBuyerId;
                    delete db._pokemonMarket[pbuyListId].pendingAt;
                    saveDB();
                    chatObj.sendMessage(`⏰ Purchase request from <@${senderId}> expired.`, { mentions: [senderId, pbuySellerID] }).catch(() => {});
                }
            }, 90000);
            return chatObj.sendMessage(
                `🛒 *PURCHASE REQUEST!* 🛒\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `<@${senderId}> wants to buy:\n` +
                `${pbuyListing.pokemon.emoji} *${pbuyListing.pokemon.name}* for *$${pbuyListing.price.toLocaleString()}*\n\n` +
                `<@${pbuySellerID}> — reply with:\n` +
                `✅ *.pyes* — confirm sale\n` +
                `❌ *.pno* — decline\n` +
                `_(Expires in 90 seconds)_`,
                { mentions: [senderId, pbuySellerID] }
            ).catch(() => {});
        }

        // ── .pyes (seller confirms sale) ──────────────────────────────────────
        if (command === '.pyes') {
            if (!db._pokemonMarket) return;
            const pyesEntry = Object.entries(db._pokemonMarket).find(([,l]) => l.sellerId === senderId && l.pendingBuyerId);
            if (!pyesEntry) return msg.reply('❌ No pending purchase request for your listing.');
            const [pyesId, pyesTrade] = pyesEntry;
            const pyesBuyerId = pyesTrade.pendingBuyerId;
            initUser(senderId); initUser(pyesBuyerId);
            if (db[pyesBuyerId].wallet < pyesTrade.price) {
                delete db._pokemonMarket[pyesId].pendingBuyerId;
                delete db._pokemonMarket[pyesId].pendingAt;
                saveDB();
                return chatObj.sendMessage(`❌ *Trade failed!* <@${pyesBuyerId}> doesn't have enough money.`, { mentions: [senderId, pyesBuyerId] }).catch(() => {});
            }
            const pyesParty = db[senderId].pokemon || [];
            const pyesPokeIdx = pyesParty.findIndex(p => p.name.toLowerCase() === pyesTrade.pokemon.name.toLowerCase());
            if (pyesPokeIdx !== -1) pyesParty.splice(pyesPokeIdx, 1);
            db[pyesBuyerId].wallet -= pyesTrade.price;
            db[senderId].wallet += pyesTrade.price;
            if (!db[pyesBuyerId].pokemon) db[pyesBuyerId].pokemon = [];
            db[pyesBuyerId].pokemon.push({ ...pyesTrade.pokemon });
            delete db._pokemonMarket[pyesId];
            saveDB();
            return chatObj.sendMessage(
                `🎉 *TRADE COMPLETE!* 🎉\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `${pyesTrade.pokemon.emoji} *${pyesTrade.pokemon.name}* sold!\n` +
                `💰 Price: $${pyesTrade.price.toLocaleString()}\n` +
                `🛒 Buyer: <@${pyesBuyerId}>\n` +
                `💸 Seller: <@${senderId}>\n\n` +
                `✅ <@${pyesBuyerId}> — check \`.inv\`!\n` +
                `✅ <@${senderId}> — +$${pyesTrade.price.toLocaleString()} in wallet 💵`,
                { mentions: [pyesBuyerId, senderId] }
            ).catch(() => {});
        }

        // ── .pno (seller declines sale) ───────────────────────────────────────
        if (command === '.pno') {
            if (!db._pokemonMarket) return;
            const pnoEntry = Object.entries(db._pokemonMarket).find(([,l]) => l.sellerId === senderId && l.pendingBuyerId);
            if (!pnoEntry) return msg.reply('❌ No pending purchase request for your listing.');
            const [pnoId, pnoTrade] = pnoEntry;
            const pnoBuyerId = pnoTrade.pendingBuyerId;
            delete db._pokemonMarket[pnoId].pendingBuyerId;
            delete db._pokemonMarket[pnoId].pendingAt;
            saveDB();
            return chatObj.sendMessage(
                `❌ *Deal declined.*\n<@${senderId}> rejected the offer from <@${pnoBuyerId}>.\n_Listing is still active for others._`,
                { mentions: [senderId, pnoBuyerId] }
            ).catch(() => {});
        }

        // ── .pcancelsell (seller removes listing) ────────────────────────────
        if (command === '.pcancelsell') {
            if (!db._pokemonMarket) return msg.reply('❌ No active listings.');
            const pcancelEntry = Object.entries(db._pokemonMarket).find(([,l]) => l.sellerId === senderId);
            if (!pcancelEntry) return msg.reply('❌ You have no active Pokémon listing.');
            const [pcancelId, pcancelListing] = pcancelEntry;
            if (!db[senderId].pokemon) db[senderId].pokemon = [];
            const alreadyInParty = db[senderId].pokemon.some(p => p.name === pcancelListing.pokemon.name);
            if (!alreadyInParty) db[senderId].pokemon.push(pcancelListing.pokemon);
            delete db._pokemonMarket[pcancelId];
            saveDB();
            return msg.reply(`✅ Listing for ${pcancelListing.pokemon.emoji} *${pcancelListing.pokemon.name}* removed.`);
        }

        // ── .market (view open pokemon listings) ──────────────────────────────
        if (command === '.market') {
            if (!db._pokemonMarket || Object.keys(db._pokemonMarket).length === 0)
                return msg.reply(`🏪 *POKÉMON MARKET*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n_No Pokémon listed right now!_\n\nSell yours: \`.psell [pokemon] [price]\``);
            let mktOut = `🏪 *POKÉMON MARKET* 🏪\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            let mktCount = 0;
            for (const [, lst] of Object.entries(db._pokemonMarket)) {
                const p = lst.pokemon;
                const pTag = lst.pendingBuyerId ? ` ⏳` : '';
                mktOut += `${p.emoji} *${p.name}* Lv.${p.level || 1} [${p.tier || '?'}]${pTag}\n`;
                mktOut += `   ❤️ ${p.hp}/${p.maxHp} | ⚔️ ${p.atk} | 💰 $${lst.price.toLocaleString()}\n`;
                mktOut += `   👤 <@${lst.sellerId}> — tag their msg + *.pbuy*\n\n`;
                if (++mktCount >= 10) break;
            }
            mktOut += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n• Sell: \`.psell [pokemon] [price]\`\n• Cancel: \`.pcancelsell\``;
            return msg.reply(mktOut);
        }

    } catch (err) {
        console.error('Critical bot error:', err.message);
    }
});

// ── LINK WARNING TRACKER ──────────────────────────────────────────────────────
let linkWarnings = {};  // { userId_chatId: count }

// ── FUNNY ROAST LINES (for .roast and .beg) ───────────────────────────────────
const FUNNY_ROASTS = [
    "You're the human version of a participation trophy. 🏆",
    "I've seen better moves at a chess club for grandmas. ♟️",
    "Your WiFi password is probably 'password123', isn't it? 🔑",
    "You bring joy to everyone when you leave the room. 👋",
    "Your cooking is so bad even the smoke alarm cheers you on. 🔔",
    "You're not stupid, you just have bad luck thinking. 🧠💀",
    "Even Google can't find your worth. 🔍",
    "You're the reason instructions have warnings on them. ⚠️",
    "Your birth certificate is an apology letter from the hospital. 📜",
    "If brains were petrol, you couldn't power a scooter. ⛽",
    "You're like a cloud — when you disappear it's a beautiful day. ☁️",
    "I'd roast you harder but my mom said I can't burn trash. 🗑️🔥",
    "You have something on your chin... no wait, that's just your personality. 😬",
    "You're the human equivalent of a 'terms and conditions' page. 📃",
    "Your ex was so right about everything. 💯",
    "Even your shadow tries to walk away from you. 🚶‍♂️",
    "If stupidity was a sport, you'd be an Olympian. 🥇",
    "You were born because a condom broke. Sorry, that's just facts. 😂",
    "Your hairline is running away from your face. 🏃",
    "I've met rocks smarter than you. 🪨",
    "You're like a software update — nobody wants you but you keep showing up. 💻",
    "Your life is the loading screen that never ends. ⏳",
    "Even your imaginary friend reported you for being boring. 🫀",
    "You're proof that even evolution makes mistakes sometimes. 🦧",
    "Your vibe is so off it needs a firmware update. 📡",
    "You're like a broken pencil — absolutely pointless. ✏️",
    "I'm not saying you're ugly, but Halloween must be your favourite holiday. 🎃",
    "You're the type to bring a fork to a soup kitchen. 🍴🍲",
    "I've eaten alphabet soup and pooped out smarter sentences than you. 💩",
    "You're so dry, camels feel bad for you. 🐪",
    "Your personality has the energy of a dying phone at 1%. 🔋",
    "You peaked in a dream you haven't had yet. 💤",
    "You're not even the main character in your own life. 🎬",
    "Your jokes are so bad they come back around to being good... jk they're still bad. 😐",
    "I'd say go to hell but I don't want to ruin their vibe. 😈",
    "You're the human equivalent of stepping on a LEGO. 🧩",
    "The trash gets picked up more consistently than your potential. 🚛",
    "You're what happens when AutoCorrect loses the will to try. 📝",
];
const BEG_ROASTS = [
    "Here's some charity money, you absolute broke goblin. 😂",
    "Congrats, you begged better than a stray dog. Here's your reward! 🐕",
    "Even the piggy bank felt sorry for you. Here! 🐷",
    "Stop begging and get a job... but okay fine, here. 💸",
    "You're so broke even your wallet cried. We felt bad. Here's cash! 😭",
    "The begging hotline connected you straight to us. Here's your survival money! 📞",
    "Poverty speedrun any% complete. Here's your consolation prize! 🏃",
    "You smelled like broke from here. Take this and buy some dignity. 🤑",
    "Even the economy felt bad for you. Here! 💰",
    "You've unlocked the 'Certified Beggar' achievement. +cash! 🏅",
];

// ── PATCH: Add new commands to the SECOND message_create listener ─────────────
// We inject into the existing message handler by extending it.
// Since both listeners run, we add a THIRD listener for new commands only.

client.on('messageCreate', async msg => {
    try {
        if (msg.partial) msg = await msg.fetch();
        if (!msg.author) return;
        if (typeof msg.author !== "string" && !msg.author.id) return;
    } catch (e) {
        console.error('Partial fetch failed:', e.message);
        return;
    }
    // FIX: if an earlier messageCreate listener already wrapped this message,
    // msg.author is a plain string ID (not a Discord User object) — .bot would throw/misbehave.
    if (!msg.__wrapped && msg.author.bot) return;  // FIX: guard against system/webhook messages
    msg = wrapMessage(msg);
    try {
        let body = msg.body ? msg.body.trim() : '';
        body = body.replace(/^\.\s+/, '.');
        const senderId = msg.author || msg.from;
        if (!body) return;

        const chatObj = await msg.getChat();
        const isGroupChat = chatObj.isGroup;

        let isMod = await checkIsMod(msg);

        // ── SECURITY: Auto link detection in groups ───────────────────────────
        if (isGroupChat && !isMod && !body.startsWith('.')) {
            const urlRegex = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|bit\.ly\/|tinyurl\.com\/)[^\s]*/i;
            if (urlRegex.test(body)) {
                const cid = chatObj.id._serialized;
                const warnKey = `${senderId}_${cid}`;
                linkWarnings[warnKey] = (linkWarnings[warnKey] || 0) + 1;
                const count = linkWarnings[warnKey];
                const mod1 = MOD_NUMBERS[0];
                const mod2 = MOD_NUMBERS[1];

                if (count >= 3) {
                    // Kick the user
                    try { await chatObj.removeParticipants([senderId]); } catch (_) {}
                    delete linkWarnings[warnKey];
                    return chatObj.sendMessage(
                        `🚫 *USER REMOVED* 🚫\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                        `👤 <@${senderId}> has been *removed from the group*.\n` +
                        `📋 *Reason:* Sending links (3 violations)\n\n` +
                        `👮 Notifying: <@${mod1}> <@${mod2}>`,
                        { mentions: [senderId, mod1, mod2] }
                    ).catch(() => {});
                } else {
                    const warnsLeft = 3 - count;
                    return chatObj.sendMessage(
                        `⚠️ *LINK WARNING ${count}/3* ⚠️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                        `<@${senderId}> — *sending links is NOT allowed!*\n` +
                        `❗ You have *${warnsLeft} warning${warnsLeft !== 1 ? 's' : ''} left* before removal.\n\n` +
                        `👮 Mods notified: <@${mod1}> <@${mod2}>`,
                        { mentions: [senderId, mod1, mod2] }
                    ).catch(() => {});
                }
            }
        }

        if (!body.startsWith('.')) return;
        const chatId = chatObj.id._serialized;
        if (!isBotActiveInChat(chatId) && body !== '.bot on' && body !== '.bot off' && body !== '.lobby' && body !== '.unlobby') return;


        const args = body.split(' ').filter(a => a !== '');
        const command = args[0].toLowerCase();

        // ── LOBBY GC: block forbidden commands ───────────────────────────────
        if (isGroupChat && isLobbyGC(chatId) && LOBBY_BLOCKED_COMMANDS.has(command)) {
            return msg.reply(`🏛️ *Lobby GC Mode* — This command is not available here.\n_Gambling & Pokémon catching are disabled in lobby groups._`).catch(() => {});
        }

        // ── .help / .mods — tag all group admins ─────────────────────────────
        // (.help/.mods and .owners handled in another handler — removed duplicate)

        // ── .menu ─────────────────────────────────────────────────────────────
        if (command === '.menu') {
            return msg.reply(
                `🎮 *BOT COMMAND MENU* 🎮\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +

                `💰 *ECONOMY*\n` +
                `• \`.bal\` / \`.p\` / \`.profile\` — Check balance & profile\n` +
                `• \`.daily\` — Claim daily reward + streak bonus\n` +
                `• \`.dep [amt]\` / \`.wd [amt]\` — Deposit / Withdraw from bank\n` +
                `• \`.transfer [@user] [amt]\` — Send money to someone\n` +
                `• \`.rich\` — Top 10 richest players\n` +
                `• \`.beg\` — Beg for coins (2 min CD)\n\n` +

                `🎲 *GAMBLING*\n` +
                `• \`.casino [bet]\` — Slot machine (CD: 5 min)\n` +
                `• \`.slots [bet]\` — 3-reel slots, 3-match = 4x!\n` +
                `• \`.roulette [red/black/green] [bet]\` — Spin wheel\n` +
                `• \`.db [bet]\` / \`.double [bet]\` — Double or Nothing\n` +
                `• \`.cf [heads/tails] [bet]\` / \`.coinflip\` — Coin flip\n` +
                `• \`.rob [@user]\` — Rob someone's wallet! (CD: 5 min)\n` +
                `• \`.gamble\` — Full gambling guide\n\n` +

                `🐾 *POKÉMON*\n` +
                `• \`.catch\` — Battle a wild Pokémon (group only)\n` +
                `• \`.throwball [balltype]\` — Throw ball to catch weakened Pokémon\n` +
                `• \`.battle [@user]\` — Challenge someone to PvP\n` +
                `• \`.accept\` / \`.reject\` — Accept or decline a battle\n` +
                `• \`.health\` — View your active Pokémon's status\n` +
                `• \`.feed [pokemon] [food]\` — Feed your Pokémon\n` +
                `• \`.use [pokemon]\` — Switch your active Pokémon\n` +
                `• \`.inv\` — View full inventory & Pokémon roster\n\n` +

                `🏪 *POKÉMON MARKET*\n` +
                `• \`.psell [pokemon] [price]\` — List your Pokémon for sale\n` +
                `• \`.pbuy\` — Tag seller's msg & request to buy\n` +
                `• \`.pyes\` / \`.pno\` — Confirm or decline a sale (seller)\n` +
                `• \`.pcancelsell\` — Remove your listing\n` +
                `• \`.market\` — Browse all listed Pokémon\n\n` +

                `🛒 *SHOPS*\n` +
                `• \`.pstore\` — Pokémon balls & food store\n` +
                `• \`.shop balls\` — Pokéball shop\n` +
                `• \`.shop food\` — Food shop\n` +
                `• \`.buy [item]\` — Purchase any item\n` +
                `• \`.cstore\` — Anime card store\n` +
                `• \`.cstore ds/op/dn/pk\` — Filter by anime\n` +
                `• \`.buycard [id]\` — Buy an anime card\n` +
                `• \`.amazon\` — Heist kits & designer bags\n\n` +

                `🃏 *CARDS*\n` +
                `• \`.cards\` / \`.c\` — View your card collection\n` +
                `• \`.card [number]\` — Detailed card view\n` +
                `• \`.sell [card index] [@user] [price]\` — Sell card to someone\n` +
                `• \`.loan request [amt] [card]\` — Get loan using card as collateral\n` +
                `• \`.loan repay\` — Repay your loan\n` +
                `• \`.loan status\` — Check loan details\n\n` +

                `🎣 *ACTIVITIES*\n` +
                `• \`.fish\` — Go fishing (CD: 45s)\n` +
                `• \`.dig\` — Dig for treasure (CD: 45s)\n` +
                `• \`.sell fish/salmon/goldenfish/all\` — Sell fish catch\n\n` +

                `😂 *FUN*\n` +
                `• \`.roast [@user]\` — Roast someone\n` +
                `• \`.slap\` / \`.hug\` / \`.pat\` etc — Fun actions (tag someone)\n\n` +

                `⚙️ *UTILITY*\n` +
                `• \`.cds\` — Show all your cooldowns\n` +
                `• \`.help\` / \`.mods\` — Tag group admins\n` +
                `• \`.owners\` — Show bot owners (admin only)\n` +
                `• \`.menu\` — This command list\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
            );
        }

        // ── .roast ────────────────────────────────────────────────────────────
        if (command === '.roast') {
            let targetId = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            const roastLine = FUNNY_ROASTS[Math.floor(Math.random() * FUNNY_ROASTS.length)];

            if (!targetId) {
                // Roast the sender themselves
                return chatObj.sendMessage(
                    `🔥 *SELF-ROAST ACTIVATED* 🔥\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `🎯 <@${senderId}>, you asked for it...\n\n` +
                    `💀 ${roastLine}\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Next time tag someone else! 😂_`,
                    { mentions: [senderId] }
                ).catch(() => {});
            } else {
                // Roast the tagged user
                return chatObj.sendMessage(
                    `🔥 *ROAST INCOMING!* 🔥\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `🎯 <@${targetId}>, <@${senderId}> sent this for you...\n\n` +
                    `💀 ${roastLine}\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Get destroyed! 😂🔥_`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            }
        }

        // ── .beg ──────────────────────────────────────────────────────────────
        if (command === '.beg') {
            initUser(senderId);
            const now = Date.now();
            // 120s cooldown on beg
            if (!db[senderId].lastBeg) db[senderId].lastBeg = 0;
            if ((now - db[senderId].lastBeg) / 1000 < 120) {
                const left = Math.ceil(120 - (now - db[senderId].lastBeg) / 1000);
                return msg.reply(`😂 You just begged! Have some dignity. Wait *${left}s*.`);
            }
            const earned = Math.floor(Math.random() * 100) + 1;
            db[senderId].wallet += earned;
            db[senderId].lastBeg = now;
            saveDB();
            const roastLine = BEG_ROASTS[Math.floor(Math.random() * BEG_ROASTS.length)];
            return chatObj.sendMessage(
                `🙏 *BEG RESULT* 🙏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `💬 ${roastLine}\n\n` +
                `💰 <@${senderId}> received *+$${earned}*!\n` +
                `👛 Wallet: $${db[senderId].wallet.toLocaleString()}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [senderId] }
            ).catch(() => {});
        }

        // ── .cds (show all cooldowns) ─────────────────────────────────────────
        if (command === '.cds') {
            initUser(senderId);
            const now = Date.now();
            const u = db[senderId];
            const cdLeft = (last, cd) => {
                const diff = cd - (now - last) / 1000;
                if (diff <= 0) return '✅ Ready';
                const m = Math.floor(diff / 60);
                const s = Math.ceil(diff % 60);
                return m > 0 ? `⏳ ${m}m ${s}s` : `⏳ ${s}s`;
            };
            return msg.reply(
                `⏱️ *COOLDOWN STATUS* ⏱️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `⛏️ *Dig* (45s): ${cdLeft(u.lastDig, CD_DIG)}\n` +
                `🎣 *Fish* (45s): ${cdLeft(u.lastFish, CD_FISH)}\n` +
                `🎰 *Casino* (5min): ${cdLeft(u.lastCasino, CD_CASINO)}\n` +
                `🎰 *Slots* (1min): ${cdLeft(u.lastSlots, CD_SLOTS)}\n` +
                `🎡 *Roulette* (40s): ${cdLeft(u.lastRoulette, CD_ROULETTE)}\n` +
                `⚖️ *Double/Bet* (1min): ${cdLeft(u.lastDb, CD_DB)} [${u.dailyDbCount || 0}/15 today]\n` +
                `🪙 *Coinflip* (1min): ${cdLeft(u.lastCoinflip, CD_COINFLIP)}\n` +
                `🦹 *Rob* (5min): ${cdLeft(u.lastRob, CD_ROB)}\n` +
                `🎁 *Daily*: ${u.lastDaily && (now - u.lastDaily) < 86400000 ? `⏳ ${Math.floor((86400000 - (now - u.lastDaily)) / 3600000)}h ${Math.floor(((86400000 - (now - u.lastDaily)) % 3600000) / 60000)}m` : '✅ Ready'}\n` +
                `🙏 *Beg* (2min): ${cdLeft(u.lastBeg || 0, 120)}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
            );
        }

        // ── .pstore (combined Pokémon store) ──────────────────────────────────
        if (command === '.pstore') {
            initUser(senderId);
            let menu = `🏪 *POKÉMON STORE* 🏪\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            menu += `🔴 *POKÉBALLS*\n`;
            for (let key in POKEBALL_SHOP) {
                const b = POKEBALL_SHOP[key];
                menu += `${b.emoji} *${b.name}* — $${b.price.toLocaleString()}\n   📝 ${b.desc}\n   _(buy: \`.buy ${key}\`)_\n\n`;
            }
            menu += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n🍗 *POKÉMON FOOD*\n`;
            for (let key in FOOD_SHOP) {
                const f = FOOD_SHOP[key];
                menu += `${f.emoji} *${f.name}* — $${f.price.toLocaleString()}\n   📝 ${f.desc}\n   _(buy: \`.buy ${key}\`)_\n\n`;
            }
            menu += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n💡 Purchase anything with \`.buy [item]\``;
            return msg.reply(menu);
        }

        // ── .rich (top 10 richest in group) ───────────────────────────────────
        if (command === '.rich') {
            if (!isGroupChat) return msg.reply('❌ This command only works in groups!');
            const isValidDiscordId = id => /^\d{17,19}$/.test(id);
            const participants = chatObj.participants || [];
            const richList = [];
            for (const p of participants) {
                const uid = p.id._serialized;
                // FIX: only include valid Discord snowflake IDs
                if (!isValidDiscordId(uid)) continue;
                if (db[uid]) {
                    const u = db[uid];
                    const total = (u.wallet || 0) + (u.bank || 0);
                    richList.push({ uid, total, wallet: u.wallet || 0, bank: u.bank || 0 });
                }
            }
            richList.sort((a, b) => b.total - a.total);
            const top = richList.slice(0, 10);
            if (top.length === 0) return msg.reply('❌ No registered players in this group yet!');
            const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            let txt = `💎 *TOP 10 RICHEST PLAYERS* 💎\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            top.forEach((r, i) => {
                txt += `${medals[i]} <@${r.uid}>\n`;
                txt += `   💰 Wallet: $${r.wallet.toLocaleString()} | 🏦 Bank: $${r.bank.toLocaleString()}\n`;
                txt += `   💎 Net Worth: *$${r.total.toLocaleString()}*\n\n`;
            });
            txt += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
            const mentions = top.map(r => r.uid);
            return chatObj.sendMessage(txt, { mentions }).catch(() => {});
        }

        // ── .kick ─────────────────────────────────────────────────────────────
        if (command === '.kick') {
            if (!isGroupChat) return msg.reply('❌ This command only works in groups!');
            if (!isMod) return msg.reply('❌ Only group admins can kick members!');
            let targetId = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Tag someone or reply to their message to kick them.');
            if (targetId === senderId) return msg.reply('❌ You cannot kick yourself!');
            if (MOD_NUMBERS.includes(targetId)) return msg.reply('❌ Cannot kick a moderator!');
            try {
                await chatObj.removeParticipants([targetId]);
                return chatObj.sendMessage(
                    `🚪 *MEMBER REMOVED* 🚪\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `👤 <@${targetId}> has been *kicked from the group*.\n` +
                    `⚖️ Action by: <@${senderId}>\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                    { mentions: [targetId, senderId] }
                ).catch(() => {});
            } catch (e) {
                return msg.reply(`❌ Could not kick <@${targetId}>. Make sure the bot is an admin!`);
            }
        }

        // ── .cstore ───────────────────────────────────────────────────────────
        if (command === '.cstore') {
            const sub = (args[1] || '').toLowerCase();
            const animeFilter = { ds:'Demon Slayer', op:'One Piece', dn:'Death Note', pk:'Pokémon' };
            let pool = CARD_CATALOG;
            if (animeFilter[sub]) pool = CARD_CATALOG.filter(c => c.anime === animeFilter[sub]);

            let out = `🃏 *ANIME CARD STORE* 🃏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
            out += `_Filter: \`.cstore ds\` | \`.cstore op\` | \`.cstore dn\` | \`.cstore pk\`_\n\n`;

            const byTier = {};
            pool.forEach(c => { if (!byTier[c.tier]) byTier[c.tier] = []; byTier[c.tier].push(c); });

            for (let t = 1; t <= 7; t++) {
                if (!byTier[t]) continue;
                out += `${TIER_EMOJI[t]} *TIER ${t} — ${TIER_NAMES[t]}*\n`;
                byTier[t].forEach(c => {
                    out += `  #${c.id} ${c.emoji} *${c.name}* [${c.anime}] — $${c.price.toLocaleString()}\n`;
                });
                out += '\n';
            }
            out += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n💳 Buy: \`.buycard [card ID]\``;
            return msg.reply(out);
        }

        // ── .buycard ──────────────────────────────────────────────────────────
        if (command === '.buycard') {
            initUser(senderId);
            const cardId = parseInt(args[1]);
            if (isNaN(cardId)) return msg.reply('❌ Usage: `.buycard [card ID]`\nSee card IDs in `.cstore`');
            const card = CARD_CATALOG.find(c => c.id === cardId);
            if (!card) return msg.reply('❌ Card not found! Check `.cstore` for valid IDs.');
            if (db[senderId].wallet < card.price) return msg.reply(`❌ Not enough funds!\n💰 Need: $${card.price.toLocaleString()}\n👛 You have: $${db[senderId].wallet.toLocaleString()}`);
            const alreadyOwns = (db[senderId].cardInventory || []).some(c => c.id === card.id);
            if (alreadyOwns) return msg.reply(`❌ You already own *${card.name}*! Cards are unique.`);
            db[senderId].wallet -= card.price;
            db[senderId].cardInventory.push({ ...card, purchasedAt: Date.now() });
            saveDB();
            try {
                const media = await MessageMedia.fromUrl(card.img);
                return chatObj.sendMessage(media, { caption:
                    `🃏 *CARD PURCHASED!* 🃏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `${card.emoji} *${card.name}*\n🎌 Anime: ${card.anime}\n${TIER_EMOJI[card.tier]} Tier: ${card.tier} — ${TIER_NAMES[card.tier]}\n\n` +
                    `💳 Paid: *$${card.price.toLocaleString()}*\n👛 Balance: $${db[senderId].wallet.toLocaleString()}\n\n` +
                    `📦 Check your collection with \`.cards\`!`
                });
            } catch (_) {
                return msg.reply(
                    `🃏 *CARD PURCHASED!*\n${card.emoji} *${card.name}* [${card.anime}] — Tier ${card.tier} (${TIER_NAMES[card.tier]})\n` +
                    `💳 Paid: *$${card.price.toLocaleString()}*\n👛 Balance: $${db[senderId].wallet.toLocaleString()}`
                );
            }
        }

        // ── .cards / .c ───────────────────────────────────────────────────────
        if (command === '.cards' || command === '.c') {
            let target = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null) || senderId;
            initUser(target);
            const cards = db[target].cardInventory || [];
            if (cards.length === 0) return msg.reply(`❌ <@${target}> has no cards! Buy from \`.cstore\`.`);
            let out = `🃏 *<@${target}>'s Card Collection* 🃏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            cards.forEach((c, i) => {
                out += `${i+1}. ${TIER_EMOJI[c.tier]} ${c.emoji} *${c.name}* [${c.anime}] — Tier ${c.tier} (${TIER_NAMES[c.tier]})\n`;
            });
            out += `\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Type \`.card [number]\` for detailed view!_`;
            return chatObj.sendMessage(out, { mentions: [target] }).catch(() => {});
        }

        // ── .card [number] ────────────────────────────────────────────────────
        if (command === '.card') {
            let target = msg.mentionedIds?.[0] || senderId;
            initUser(target);
            const num = parseInt(args[1]);
            const cards = db[target].cardInventory || [];
            if (isNaN(num) || num < 1 || num > cards.length)
                return msg.reply(`❌ Usage: \`.card [1-${cards.length}]\`\nSee your cards with \`.cards\``);
            const card = cards[num - 1];
            const cardDetail =
                `🃏 *CARD DETAILS* 🃏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `${card.emoji} *${card.name}*\n` +
                `🎌 *Anime:* ${card.anime}\n` +
                `${TIER_EMOJI[card.tier]} *Tier:* ${card.tier} — ${TIER_NAMES[card.tier]}\n` +
                `💰 *Market Value:* $${card.price.toLocaleString()}\n` +
                `📋 *Card ID:* #${card.id}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `_Owned by <@${target}>_`;
            try {
                const media = await MessageMedia.fromUrl(card.img);
                return chatObj.sendMessage(media, { caption: cardDetail, mentions: [target] });
            } catch (_) { return chatObj.sendMessage(cardDetail, { mentions: [target] }).catch(() => {}); }
        }

        // ── .loan ─────────────────────────────────────────────────────────────
        if (command === '.loan') {
            initUser(senderId);
            const sub = (args[1] || '').toLowerCase();

            // .loan (no sub) → show help
            if (!sub) {
                return msg.reply(
                    `💸 *Loan Command Usage*\n` +
                    `• \`.loan request <amount> <card index>\` — Request a loan.\n` +
                    `• \`.loan repay\` — Repay your current loan.\n` +
                    `• \`.loan status\` — Check your active loan details.\n\n` +
                    `🔒 You need to stake a card of the matching tier to request up to its maximum loan amount.\n\n` +
                    `*Per-Tier Maximums*\n` +
                    `• Tier 1: up to 20K | 5% interest over 1 day(s)\n` +
                    `• Tier 2: up to 40K | 6% interest over 2 day(s)\n` +
                    `• Tier 3: up to 100K | 8% interest over 3 day(s)\n` +
                    `• Tier 4: up to 250K | 10% interest over 7 day(s)\n` +
                    `• Tier 5: up to 400K | 12% interest over 10 day(s)\n` +
                    `• Tier 6: up to 600K | 13% interest over 12 day(s)\n` +
                    `• Tier 7: up to 2M | 15% interest over 21 day(s)`
                );
            }

            // .loan status
            if (sub === 'status') {
                const loan = db[senderId].loan;
                if (!loan) return msg.reply('✅ You have no active loan! Use `.loan request` to take one.');
                const daysLeft = Math.max(0, Math.ceil((loan.dueDate - Date.now()) / 86400000));
                const overdue  = Date.now() > loan.dueDate;
                return msg.reply(
                    `📋 *Loan Status*\n` +
                    `• Card: ${loan.card.emoji} ${loan.card.name} (Tier ${loan.card.tier})\n` +
                    `• Principal: $${loan.principal.toLocaleString()}\n` +
                    `• Interest: ${loan.interest}%\n` +
                    `• Amount due: $${loan.amountDue.toLocaleString()}\n` +
                    `• Due date: ${new Date(loan.dueDate).toDateString()}\n` +
                    `> ${overdue ? '🔴 OVERDUE! Card seized!' : `⏳ ${daysLeft} day(s) remaining.`}`
                );
            }

            // .loan repay
            if (sub === 'repay') {
                const loan = db[senderId].loan;
                if (!loan) return msg.reply('❌ You have no active loan to repay!');
                if (Date.now() > loan.dueDate) {
                    db[senderId].loan = null; saveDB();
                    return msg.reply(`💀 *LOAN EXPIRED!*\nYour *${loan.card.emoji} ${loan.card.name}* has been *permanently seized!* You snooze you lose! 😈`);
                }
                if (db[senderId].wallet < loan.amountDue) {
                    return msg.reply(`❌ Not enough cash!\n💸 Amount due: *$${loan.amountDue.toLocaleString()}*\n👛 Your wallet: *$${db[senderId].wallet.toLocaleString()}*`);
                }
                db[senderId].wallet -= loan.amountDue;
                db[senderId].cardInventory.push(loan.card);
                db[senderId].loan = null; saveDB();
                return msg.reply(
                    `✅ *LOAN REPAID SUCCESSFULLY!* ✅\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `💳 Paid: *$${loan.amountDue.toLocaleString()}*\n` +
                    `🃏 Your *${loan.card.emoji} ${loan.card.name}* has been *returned* to your collection!\n` +
                    `👛 Wallet: $${db[senderId].wallet.toLocaleString()}\n\n` +
                    `_Good financial discipline! 💪_`
                );
            }

            // .loan request <amount> <card index>
            if (sub === 'request') {
                if (db[senderId].loan) {
                    const roasts = [
                        `Bruh you still haven't paid your last loan 💀 You're giving "broke with extra steps" energy!`,
                        `First pay back what you already owe, you serial debtor! 😂 The bank isn't your personal ATM!`,
                        `Another loan?? Last one still pending! You're collecting debts like Pokémon cards! 🃏💸`,
                    ];
                    return msg.reply(`❌ ${roasts[Math.floor(Math.random()*roasts.length)]}\n\n_Use \`.loan repay\` to clear your current loan first!_`);
                }
                const amount   = parseInt(args[2]);
                const cardIdx  = parseInt(args[3]) - 1;
                const cards    = db[senderId].cardInventory || [];
                if (isNaN(amount) || amount <= 0) return msg.reply('❌ Usage: `.loan request [amount] [card index]`');
                if (isNaN(cardIdx) || cardIdx < 0 || cardIdx >= cards.length)
                    return msg.reply(`❌ Invalid card index! You have ${cards.length} card(s). Use \`.cards\` to see them.`);
                const card = cards[cardIdx];
                const cfg  = LOAN_TIERS[card.tier];
                if (amount > cfg.maxLoan) return msg.reply(`❌ Tier ${card.tier} card max loan is *$${cfg.maxLoan.toLocaleString()}*!`);
                const interest   = cfg.interest;
                const amountDue  = Math.floor(amount * (1 + interest / 100));
                const dueDate    = Date.now() + cfg.days * 86400000;
                // Remove card from inventory and stake it
                db[senderId].cardInventory.splice(cardIdx, 1);
                db[senderId].wallet += amount;
                db[senderId].loan = { card, principal: amount, interest, amountDue, dueDate };
                saveDB();
                return msg.reply(
                    `💸 *LOAN APPROVED!* 💸\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `🃏 Staked: *${card.emoji} ${card.name}* (Tier ${card.tier})\n` +
                    `💵 Loan Amount: *$${amount.toLocaleString()}*\n` +
                    `📈 Interest: *${interest}%*\n` +
                    `💳 Repay: *$${amountDue.toLocaleString()}*\n` +
                    `📅 Due: *${new Date(dueDate).toDateString()}* (${cfg.days} day${cfg.days>1?'s':''})\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `⚠️ _Fail to repay → card seized FOREVER!_\n` +
                    `👛 Wallet: $${db[senderId].wallet.toLocaleString()}`
                );
            }
            return msg.reply('❌ Unknown loan command. Try `.loan` for help.');
        }

        // ── Card trade .accept / .reject (alongside battle accept/reject) ─────
        if (command === '.accept' && pendingCardTrades[senderId]) {
            initUser(senderId);
            const trade = pendingCardTrades[senderId];
            delete pendingCardTrades[senderId];
            initUser(trade.sellerId);
            if (db[senderId].wallet < trade.price)
                return msg.reply(`❌ Not enough funds!\n💰 Need: $${trade.price.toLocaleString()}\n👛 You have: $${db[senderId].wallet.toLocaleString()}`);
            // Check seller still has card
            const sellerCards = db[trade.sellerId].cardInventory || [];
            if (sellerCards[trade.cardIdx]?.id !== trade.cardData.id) {
                return msg.reply('❌ Card no longer available — seller may have moved it!');
            }
            sellerCards.splice(trade.cardIdx, 1);
            db[senderId].wallet -= trade.price;
            db[trade.sellerId].wallet += trade.price;
            db[senderId].cardInventory.push(trade.cardData);
            saveDB();
            return chatObj.sendMessage(
                `🃏 *CARD TRADE SUCCESSFUL!* 🃏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `${trade.cardData.emoji} *${trade.cardData.name}* transferred!\n` +
                `📤 <@${trade.sellerId}> received: *+$${trade.price.toLocaleString()}*\n` +
                `📥 <@${senderId}> received the card!\n\n` +
                `_Check your collection with \`.cards\`!_`,
                { mentions: [trade.sellerId, senderId] }
            ).catch(() => {});
        }

        if (command === '.reject' && pendingCardTrades[senderId]) {
            const trade = pendingCardTrades[senderId];
            delete pendingCardTrades[senderId];
            return chatObj.sendMessage(
                `❌ <@${senderId}> *rejected* the card trade offer from <@${trade.sellerId}>!`,
                { mentions: [senderId, trade.sellerId] }
            ).catch(() => {});
        }

// ── .wealthy / .rich — Top 10 richest users in this group ────────────
        if (command === '.wealthy' || command === '.rich') {
            if (!isGroupChat) return msg.reply('❌ This command only works in groups!');

            // FIX: Only use valid Discord snowflake IDs (17-19 digit numbers)
            // This removes old WhatsApp-style keys or username-based keys
            const isValidDiscordId = id => /^\d{17,19}$/.test(id);

            const richList = Object.keys(db)
                .filter(id => id !== '_config' && isValidDiscordId(id) && db[id].wallet !== undefined)
                .map(id => ({
                    id,
                    wealth: (db[id].wallet || 0) + (db[id].bank || 0)
                }))
                .sort((a, b) => b.wealth - a.wealth)
                .slice(0, 10);

            if (richList.length === 0)
                return msg.reply('❌ No users found in the database yet!');

            const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
            let text = `💰 *TOP ${richList.length} WEALTHIEST PLAYERS* 💰\n`;
            text += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;

            richList.forEach((entry, i) => {
                text += `${medals[i]} <@${entry.id}> — *$${entry.wealth.toLocaleString()}*\n`;
            });

            text += `\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Net Wealth = Wallet + Bank_`;

            return chatObj.sendMessage(text, { mentions: richList.map(e => e.id) }).catch(() => {});
        }

// ── HELPER: get target from mention or quoted msg ─────────────────────
        const getFunTarget = async () => {
            if (msg.mentionedIds?.[0]) return msg.mentionedIds[0];
            if (msg.hasQuotedMsg) return (await msg.getQuotedMessage()).author;
            return null;
        };

        // ── FUN COMMANDS ──────────────────────────────────────────────────────
        const FUN_CMD_RESPONSES = {
            play: [
                "🎮 started a game with {target} and got absolutely destroyed in 5 minutes 💀",
                "🎲 challenged {target} to chess. {target} didn't even look up from their phone 😭",
                "🎯 tried playing with {target} but {target} keeps changing the rules mid-game 😤",
                "🃏 played cards with {target} and lost every single round. Unbelievable. 💸",
                "🎮 and {target} played tag. {target} is still 'it' from 2019 😂",
                "🕹️ invited {target} to play but {target} said 'one sec' and never came back 💔",
                "🎳 played bowling with {target}. The ball went backwards. Nobody knows how. 🤷",
                "🎰 played a game with {target} and somehow both lost. That's a new record. 😮",
                "🏓 played ping pong with {target}. {target} hit the ball into next week. 📅",
                "🎮 rage-quit playing with {target} after 30 seconds. Personal record. 🏆",
                "🎲 forced {target} into a board game. {target} flipped the table. Classic. 😂",
                "🎮 played GTA with {target}. {target} drove into the ocean immediately. 🌊",
                "🏋️ and {target} played arm wrestling. The table broke. Draw! 💥",
                "🎮 queued with {target} and they went AFK in the loading screen 😑",
                "🎯 did a 1v1 with {target}. {target} tea-bagged and left. Disrespectful. 😤",
                "🎮 played hide and seek with {target}. {target} is still hiding from their responsibilities 👀",
                "🎲 started monopoly with {target}. Friendship: on thin ice. 🧊",
                "🕹️ carried {target} through the game but {target} took all the credit 🙄",
                "🎮 played AMONG US with {target}. {target} was the impostor. As always. 🔪",
                "🎯 and {target} competed. {target} lost and blamed lag. Disgusting. 😂",
                "🎮 played Minecraft with {target}. {target} punched a tree for 2 hours straight 🌲",
                "🃏 played UNO with {target} and drew +4 three times in a row. The universe hates them. 😭",
                "🎮 teamed up with {target}. Immediately regretted it. 💀",
                "🏊 challenged {target} to a swim race. {target} brought floaties. Adults. 🤦",
                "🎮 played 5 seconds with {target} and {target} already asked 'are we there yet?' 😭",
            ],
            slap: [
                "👋 slapped {target} so hard their ancestors felt it 💀",
                "🖐️ slapped {target} with the force of 1000 disappointed parents 😤",
                "👊 smacked {target} with a wet fish. Nobody knows why. 🐟",
                "🖐️ slapped {target} into next Tuesday 📅",
                "👋 slapped {target} and {target}'s wig went flying 💨",
                "🤚 gave {target} a slap so loud the neighbours called the cops 🚔",
                "🖐️ slapped {target} and {target} said 'thank you' and walked away 😳",
                "👋 slapped {target} across the chat! *CRACK* 💥",
                "🤜 slapped {target} with a slipper. Grandma-style. 👡",
                "🖐️ slapped {target} and {target} got sent to the shadow realm 👻",
                "👋 backhanded {target} into 2026 📆",
                "🤚 slapped {target} so hard Google Maps updated the location 📍",
                "🖐️ gave {target} the slap of shame 😂",
                "👊 slapped {target}'s phone right out of their hand mid-text 📱💔",
                "🤜 delivered a slap that echoed through the entire group 📢",
                "🖐️ slapped {target} into another dimension 🌀",
                "👋 slapped {target} with a rolled-up newspaper like a bad dog 🗞️🐕",
                "🤚 slapped {target} so clean it sounded like a high five 🙌",
                "🖐️ smacked {target} and the whole group heard it 👂",
                "👋 slapped {target} into therapy 🛋️",
                "🤜 slapped {target} with the power of all unread notifications 🔔",
                "🖐️ slapped {target} and time stopped for 3 seconds ⏱️",
                "👊 slapped {target} right out of their comfort zone 😳",
                "🖐️ slapped {target} so hard autocorrect couldn't even fix it 📝",
                "👋 delivered justice via slap to {target}. Court dismissed. ⚖️",
            ],
            hug: [
                "🤗 gave {target} a warm hug and {target} started crying. Touch-starved. 😢",
                "💛 hugged {target} so tight {target} made a squeaky toy noise 🧸",
                "🤗 tried to hug {target} but {target} said 'ew get off' 😭",
                "💗 hugged {target} and {target} patted back awkwardly. They tried. 😂",
                "🤗 gave {target} a bear hug and cracked 3 of their ribs. Oops. 🦴",
                "💛 and {target} had a moment. The whole group is crying. 😭",
                "🫂 hugged {target} for 47 seconds. Nobody said anything. 🕐",
                "🤗 ran and hugged {target} full speed. Both fell. Worth it. 😂",
                "💗 gave {target} the most comforting hug known to mankind 🌟",
                "🤗 hugged {target} and {target}'s trust issues temporarily paused ⏸️",
                "🫂 went in for a hug but {target} went for a handshake. Awkward. 😬",
                "💛 squeezed {target} so tight their eyes popped 👀",
                "🤗 surprised {target} with a hug from behind. {target} screamed. 😱",
                "💗 held {target} and whispered 'we're getting through this' 🥹",
                "🫂 and {target} hugged for so long people thought they fused together 🧬",
                "🤗 tried to hug {target} but {target} pointed at a 'no touching' sign 🚫",
                "💛 gave {target} the dad-hug they never had 🥲",
                "🤗 full-body launched onto {target}. {target} accepted their fate. 💀",
                "🫂 hugged {target} and whispered 'you owe me $20' right after 💸",
                "🤗 and {target} have now officially entered the homies phase 👊",
                "💗 gave {target} a hug so good {target} called their mom after 📞",
                "🤗 hugged {target} and solved 3 of their life problems in the process 🧩",
                "🫂 wrapped arms around {target} and refused to let go 🔒",
                "💛 hugged {target} and the surrounding temperature rose by 5 degrees 🌡️",
                "🤗 gave {target} a group hug by themselves. Champion. 🏆",
            ],
            fuck: [
                "💀 and {target} tried. The vibe was off. It was quiet. Very quiet. 😶",
                "😳 looked at {target} and immediately regretted sending this command 💀",
                "🔥 and {target} got together and somehow caught feelings instead. Tragic. 💔",
                "😂 sent this command to {target} and {target} replied 'lol ok' and left 🚪",
                "💀 and {target} disappeared for 5 minutes. Nobody asked. Nobody will. 🤐",
                "😈 and {target} — the group doesn't wanna know. The group will never know. 🙈",
                "💥 and {target}... yep. That happened. Allegedly. 🤷",
                "😤 tried, but {target} had a headache. Again. Third time this week. 🥴",
                "🔥 and {target} made memories the internet wasn't ready for 📵",
                "😂 sent this command and {target} screenshotted it. Sent to mom. 📸",
                "💀 and {target} had the most awkward 47 seconds in recorded history ⏱️",
                "😳 and {target} — we move on. We don't discuss. We heal. 🛐",
                "🔥 thought it was gonna be legendary with {target}. It was not. 💩",
                "😈 and {target} wrote history. Nobody will read that chapter. 📖🔒",
                "💥 and {target} — the neighbours filed a noise complaint. 🏘️",
                "😂 this command was sent to {target}. {target} is now in therapy. 🛋️",
                "💀 and {target} went for it. {target}'s character arc has changed forever. 🌀",
                "😤 and {target} — God is watching. And taking notes. 📋👆",
                "🔥 confessed to {target} via this command. {target} said 'ok' and nothing else. 💬",
                "😳 and {target} started something the bot is NOT going to finish describing 🙅",
                "💀 and {target}. Let's just say the simulation nearly crashed. 💻",
                "😈 did the unthinkable with {target}. The prophecy is fulfilled. 📜",
                "🔥 and {target} have entered a new era. Nobody is ready. 🌅",
                "😂 and {target} — zero chemistry, maximum chaos. 💥",
                "💀 and {target} tried once. Just once. The universe said 'no more'. 🌍",
            ],
            kiss: [
                "💋 kissed {target} and {target} wiped it off immediately 😭",
                "😘 went in for a kiss but {target} turned their head. Cheek kiss. Pain. 💔",
                "💋 kissed {target} and {target} blushed so hard they went offline 🌹",
                "😏 kissed {target} and now the whole group is gossiping 👀",
                "💋 surprised {target} with a kiss. {target} bit them instead. Classic. 😂",
                "😘 gave {target} a kiss and {target} said 'ew you have garlic breath' 🧄",
                "💋 kissed {target}'s forehead like a parent. Weird but sweet. 😂",
                "😍 and {target} kissed under the stars. Okay Romeo take it easy. 🌟",
                "💋 kissed {target} and {target} immediately changed their relationship status. Fast. 💍",
                "😘 went for {target}'s lips but accidentally kissed {target}'s nose. Still counts. 👃",
                "💋 kissed {target} and {target} passed out from the shock 😵",
                "😏 gave {target} the kiss of betrayal. Et tu? 🗡️",
                "💋 kissed {target} and {target} rated it 6/10. Cold. 😶",
                "😘 kissed {target} gently. {target} cried. Nobody expected that. 😭",
                "💋 gave {target} a flying kiss. {target} let it hit the wall. 🧱",
                "😍 kissed {target} for so long the bot had to restart ♻️",
                "💋 kissed {target} and {target} said 'okay but that doesn't mean anything' 💔",
                "😘 leaned in for a kiss with {target}. {target} sneezed. Perfect timing. 🤧",
                "💋 kissed {target} and immediately regretted it. The feeling was mutual. 😬",
                "😏 kissed {target} on the hand like royalty. {target} did not ask for this. 👑",
                "💋 kissed {target} softly. {target} short-circuited. 💻",
                "😘 and {target} kissed and three people in the group lost their appetite 🤢",
                "💋 gave {target} a kiss and {target}'s whole personality changed 🌀",
                "😍 kissed {target} and heard wedding bells. {target} heard nothing. 💔",
                "💋 kissed {target} right in the middle of their sentence. Rude but iconic. 😂",
            ],
            lick: [
                "👅 licked {target}'s cheek like a golden retriever 🐕",
                "😜 licked {target} and {target} immediately questioned their life choices 💀",
                "👅 licked {target}'s face and {target} tasted like regret 😂",
                "😛 licked {target}'s ear and {target} yeeted off the building 🏢",
                "👅 licked {target} and {target} filed a formal complaint with HR 📋",
                "😜 licked {target} like an ice cream. {target} was NOT ice cream. 🍦",
                "👅 gave {target} the full dog treatment. Wet. Unwanted. Enthusiastic. 🐶",
                "😛 licked {target} and {target} looked at the camera like The Office 📷",
                "👅 licked {target} and {target} has been in the shower for 3 hours now 🚿",
                "😜 licked {target}'s forehead. Nobody in the group is okay. 😶",
                "👅 licked {target} and {target} said 'stop that' in 4 languages 🌍",
                "😛 licked {target} and the whole chat went silent for 10 seconds 🔇",
                "👅 and {target} — someone needed to call animal control 🚨",
                "😜 licked {target} and {target} moved to a different country 🌏",
                "👅 licked {target} clean off. {target} evaporated. 💨",
                "😛 licked {target} like a stamp. Sent. 📮",
                "👅 licked {target} and {target} said 'not again' — AGAIN?? 😱",
                "😜 gave {target} the full lick experience. {target} uninstalled the app. 📵",
                "👅 licked {target} and {target}'s soul left the body momentarily 👻",
                "😛 licked {target} and somehow unlocked a new side quest 🗺️",
                "👅 licked {target}'s phone screen. That was their password. Hacked. 💻",
                "😜 licked {target} while {target} was talking. {target} forgot every word. 😶",
                "👅 licked {target} and got immediately blocked 🚫",
                "😛 licked {target} so enthusiastically the bot blushed 🤖❤️",
                "👅 licked {target} and {target} gave it a solid 4/10 with feedback 📝",
            ],
            kill: [
                "💀 eliminated {target} with the force of 1000 unread notifications 🔔",
                "🔪 and {target} had a duel. {target} lost. Badly. 😂",
                "💀 finished {target} with a single look 👀",
                "🗡️ took out {target} before {target} could say 'wait—' ⚡",
                "💀 deleted {target} from the group chat of life 🗑️",
                "🔫 shot {target} with facts and logic. Fatal. 🧠",
                "💀 and {target} fought. {target} disconnected from reality 📡",
                "🗡️ ended {target}'s career, reputation, and WiFi all at once 📵",
                "💀 sneezed and {target} flew away 🤧💨",
                "🔪 hunted {target} across 7 group chats and found them 📱",
                "💀 and {target} — {target} respawned but with less confidence 🔄",
                "🗡️ eliminated {target} quicker than {target}'s attention span ⏱️",
                "💀 finished {target} off with the most passive-aggressive 'ok' ever sent 📩",
                "🔫 took {target} out with one sentence. The pen is mightier. ✍️",
                "💀 and {target}. Cause of death: embarrassment. 😳",
                "🗡️ hunted {target} like a final boss fight and won first try 🏆",
                "💀 ended {target}'s entire legacy in under 10 seconds ⏰",
                "🔪 sent {target} to the shadow realm. No return address. 👻",
                "💀 and {target} — witnesses said it was painless. They lied. 😂",
                "🗡️ destroyed {target} so thoroughly Google no longer recognizes their name 🔍",
                "💀 gave {target} the final boss treatment. Easy mode. 😴",
                "🔫 and {target} fought. {target} respawned as a new person. For the better. 🌱",
                "💀 wiped {target} out of the simulation entirely 🖥️",
                "🗡️ took down {target} and then walked away without looking at the explosion 🔥🚶",
                "💀 eliminated {target} from the top of the leaderboard. Step aside. 📊",
            ],
            kidnap: [
                "🚗 kidnapped {target} and {target} fell asleep in the van 😴",
                "🪢 grabbed {target} and {target} immediately asked for the WiFi password 📶",
                "🚐 kidnapped {target} but {target} started rating the van's interior 🛋️",
                "🪢 took {target} hostage. {target} is now running the operation. 💀",
                "🚗 kidnapped {target} and {target} said 'finally, an adventure' 😂",
                "🪢 tried to kidnap {target} but {target} just walked in voluntarily 🚪",
                "🚐 blindfolded {target} and took them somewhere secret. {target} filmed a vlog. 🎥",
                "🪢 kidnapped {target} and now {target} won't stop giving unsolicited opinions 🗣️",
                "🚗 snatched {target} but {target} had already packed a bag 🧳",
                "🪢 took {target} and now both are stuck arguing about what to eat 🍕🍔",
                "🚐 kidnapped {target} at 3am. {target} was already awake. No reason given. 🌙",
                "🪢 grabbed {target} and {target} sent their location to 7 people before leaving 📍",
                "🚗 kidnapped {target}. Ransom demanded. Family paid within 30 seconds. That hurt. 💸",
                "🪢 and {target} have been on the run for 4 hours. {target} is having fun. 😄",
                "🚐 kidnapped {target} and {target} started auditing all decisions 📋",
                "🪢 took {target} hostage. {target} is now giving a TED talk. 🎤",
                "🚗 tried to kidnap {target} but {target} kicked the door open 🦵",
                "🪢 kidnapped {target} and {target} organized the whole situation better 📊",
                "🚐 and {target} are still missing. The bot isn't worried. The bot is concerned. 😐",
                "🪢 grabbed {target} mid-sentence. {target} finished the sentence in the van. 😂",
                "🚗 kidnapped {target} and {target} Yelp-reviewed the experience 3/5 stars 📝",
                "🪢 took {target} and now {target} has Stockholm Syndrome within 10 minutes 💔",
                "🚐 kidnapped {target} but {target} started redecorating the van 🎨",
                "🪢 grabbed {target} but ran out of breath. {target} lapped them. 🏃",
                "🚗 kidnapped {target} and genuinely forgot why. Oops. 🤦",
            ],
            punch: [
                "🥊 punched {target} so hard {target}'s shadow felt it 👤",
                "👊 punched {target} and {target} spun like a cartoon character 🌀",
                "🥊 delivered a punch to {target} that echoed in 3 time zones ⏰",
                "👊 punched {target} and {target}'s wig went into another group chat 💨",
                "🥊 hit {target} so hard {target} buffered for 10 seconds ⏳",
                "👊 punched {target} clean into next month 📅",
                "🥊 wound up and punched {target} with the energy of a Monday morning 😤",
                "👊 sucker-punched {target} mid-sentence. {target} never finished the thought. 💭",
                "🥊 punched {target} and {target} immediately had a character arc 🌅",
                "👊 punched {target} and the bot rated it 10/10 for technique 🏅",
                "🥊 hit {target} so hard the chat went silent 🔇",
                "👊 punched {target} into sobriety and self-awareness 🧘",
                "🥊 delivered the punch {target} has needed since primary school 🏫",
                "👊 punched {target} and {target} said 'I deserved that' 😔",
                "🥊 hit {target} with the haymaker of truth 💥",
                "👊 punched {target} so hard Google felt the vibration 🌍",
                "🥊 punched {target} into the shadow realm and {target} is now rent-free in there 🧠",
                "👊 punched {target} and all of {target}'s bad decisions flashed before them 💀",
                "🥊 landed the cleanest punch on {target}. Textbook. Beautiful. 😤",
                "👊 punched {target} and {target} respawned with better energy ✨",
                "🥊 gave {target} the punch they've been ignoring from karma 🔄",
                "👊 knocked {target} clear into a different storyline 📖",
                "🥊 punched {target} and the wind said 'daaaang' 💨",
                "👊 punched {target} so hard {target}'s ancestors flinched 👴",
                "🥊 punched {target} once. That was enough. 😶",
            ],
            pat: [
                "🫶 patted {target} on the head like a golden retriever 🐾",
                "👋 gave {target} the most patronizing head pat in history 😌",
                "🫶 patted {target} gently and {target} purred 😂",
                "👋 patted {target} on the back and {target} started crying. Long time coming. 😢",
                "🫶 pat pat pat. {target} needed that. You know it. 🥹",
                "👋 patted {target} on the head. {target} is 6 foot tall. It was a stretch. 😅",
                "🫶 gave {target} the supportive pat of a disappointed parent 😔",
                "👋 patted {target} slowly like 'good try buddy'. {target} knows. 💀",
                "🫶 patted {target} on the head and {target} said 'I am NOT a child' 😤",
                "👋 gave {target} three gentle pats and walked away. Said everything. 💬",
                "🫶 patted {target}'s head and accidentally gave them +10 confidence ✨",
                "👋 pat-patted {target} and {target} went full dog mode 🐕",
                "🫶 patted {target} so softly {target} got goosebumps 😳",
                "👋 patted {target} mid-rant. {target} immediately calmed down. 🧘",
                "🫶 gave {target} the 'there there' pat. {target} is NOT okay but okay now. 😭",
                "👋 patted {target} on the head with two fingers like royalty 👑",
                "🫶 patted {target} and {target} leaned into it like a needy cat 🐱",
                "👋 gave {target} a pat that said 'you tried' without saying a word 😶",
                "🫶 patted {target} on the back for even showing up today ✅",
                "👋 gently patted {target} and {target} broke into tears immediately 😭",
                "🫶 patted {target} and {target}'s whole mood shifted from 2 to 7 📈",
                "👋 patted {target} on the head and {target} asked for it again. Twice. 🐕",
                "🫶 gave {target} the most gentle pat and everyone melted 🥺",
                "👋 patted {target} and said nothing. The silence was healing. 🌿",
                "🫶 patted {target} so kindly {target} questioned if they were loveable. They are. 💛",
            ],
            cum: [
                "💦 and {target} — the bot is not commenting. Moving on. 😐",
                "😳 and {target} — God closed 3 tabs watching that 🙈",
                "💦 pulled up on {target} and the situation escalated immediately 💀",
                "😂 and {target} — the clouds above made that face ☁️😶",
                "💦 showed up to {target}'s location. {target} was not expecting company. 🚪",
                "😳 went to {target} and {target} is now requiring at least 20 minutes 🕐",
                "💦 dropped in on {target} and {target}'s vibe changed permanently 🌀",
                "😂 and {target} — the WiFi slowed down at that exact moment. Suspicious. 📶",
                "💦 arrived. {target} knew. Nobody said a word. 😶",
                "😳 and {target} — angels covered their eyes 👼",
                "💦 and {target} — the humidity in the chat just went up 💧",
                "😂 showed up for {target} unannounced. {target} was mid-sentence. Didn't matter. 🗣️",
                "💦 and {target} — rated M for Mature. Bot is not mature. 🤖",
                "😳 and {target} went somewhere the group cannot follow 🚫",
                "💦 and {target} — two minutes of silence for the survivors 🕯️",
                "😂 and {target}. The CCTV footage has been destroyed. Good. 🔥",
                "💦 appeared for {target} and {target} questioned several life choices 💭",
                "😳 met {target} in the worst possible way. Both survived. Barely. 😵",
                "💦 and {target} — the server lagged. Probably related. 💻",
                "😂 and {target} — the chat needed a cooldown after this one 🧊",
                "💦 showed up to {target}. {target} rated it satisfactory/10. 📝",
                "😳 and {target} — even the bot needs therapy now. 🛋️",
                "💦 and {target} — bystanders are filing for witness protection 🛡️",
                "😂 and {target} had a moment. It lasted 12 seconds. {target} pretends it was longer. ⏱️",
                "💦 and {target} — we don't talk about it. We will NEVER talk about it. 🤐",
            ],
        };

        const FUN_COMMANDS = ['play','slap','hug','fuck','kiss','lick','kill','kidnap','punch','pat','cum'];
        const cleanCmd = command.startsWith('.') ? command.slice(1) : command;

        if (FUN_COMMANDS.includes(cleanCmd)) {
            const targetId = await getFunTarget();
            const responses = FUN_CMD_RESPONSES[cleanCmd];
            const raw = responses[Math.floor(Math.random() * responses.length)];
            const senderName = `<@${senderId}>`;

            if (!targetId) {
                return chatObj.sendMessage(
                    `❌ Tag someone or reply to their message!\nUsage: \`.${cleanCmd} @user\``,
                    { mentions: [senderId] }
                ).catch(() => {});
            }

            const targetName = `<@${targetId}>`;
            const text = raw.replace(/\{target\}/g, targetName);

            return chatObj.sendMessage(
                `${senderName} ${text}`,
                { mentions: [senderId, targetId] }
            ).catch(() => {});
        }
    } catch (err) {
        console.error('New commands error:', err.message);
    }
});

// ── .amazon STORE ─────────────────────────────────────────────────────────────
client.on('messageCreate', async msg => {
    try {
        if (msg.partial) msg = await msg.fetch();
        if (!msg.author) return;
        if (typeof msg.author !== "string" && !msg.author.id) return;
    } catch (e) {
        console.error('Partial fetch failed:', e.message);
        return;
    }
    if (!msg.__wrapped && msg.author.bot) return;  // FIX: guard against system/webhook messages
    msg = wrapMessage(msg);
    try {
        let body = msg.body ? msg.body.trim() : '';
        body = body.replace(/^\.\s+/, '.');
        if (!body.startsWith('.amazon')) return;
        const senderId = msg.author || msg.from;
        const chatObj  = await msg.getChat();
        if (!isBotActiveInChat(chatObj.id._serialized)) return;
        const args     = body.split(' ').filter(a => a !== '');
        const command  = args[0].toLowerCase();
        if (command !== '.amazon') return;

        initUser(senderId);

        const sub = (args[1] || '').toLowerCase();

        // ── .amazon — Show store ──────────────────────────────────────────────
        if (!sub || sub === 'store') {
            let out = `🛒 *AMAZON STORE* 🛒\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            out += `🛡️ *HEIST PROTECTION KITS*\n_(Protects your wallet from .rob attacks)_\n\n`;
            for (const [k, kit] of Object.entries(HEIST_KITS)) {
                const owned = db[senderId].activeHeistKit === k;
                out += `${kit.emoji} *${kit.name}*${owned ? ' ✅ OWNED' : ''}\n`;
                out += `   💰 Price: *$${kit.price.toLocaleString()}*\n`;
                out += `   📋 ${kit.desc}\n`;
                out += `   🛒 Buy: \`.amazon buy kit ${k}\`\n\n`;
            }
            out += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
            out += `👜 *DESIGNER BAGS*\n_(Replaces your current bag in inventory)_\n\n`;
            for (const [k, bag] of Object.entries(AMAZON_BAGS)) {
                out += `${bag.emoji} *${bag.name}*\n`;
                out += `   💰 Price: *$${bag.price.toLocaleString()}*\n`;
                out += `   📋 ${bag.desc}\n`;
                out += `   🛒 Buy: \`.amazon buy bag ${k}\`\n\n`;
            }
            out += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
            out += `💳 *Your wallet:* $${db[senderId].wallet.toLocaleString()}\n`;
            out += `🛡️ *Active kit:* ${db[senderId].activeHeistKit ? HEIST_KITS[db[senderId].activeHeistKit]?.name : 'None'}\n`;
            out += `👜 *Current bag:* ${db[senderId].inventory.assignedBag || 'Basic Sack'}`;
            return msg.reply(out);
        }

        // ── .amazon buy kit <kitkey> ──────────────────────────────────────────
        if (sub === 'buy' && (args[2] || '').toLowerCase() === 'kit') {
            const kitKey = (args[3] || '').toLowerCase();
            const kit    = HEIST_KITS[kitKey];
            if (!kit) return msg.reply(`❌ Unknown kit! Valid: ${Object.keys(HEIST_KITS).map(k => `\`.amazon buy kit ${k}\``).join(', ')}`);
            if (db[senderId].activeHeistKit === kitKey) return msg.reply(`✅ You already own the *${kit.name}*! It's active on your account.`);
            if (db[senderId].wallet < kit.price) return msg.reply(`❌ Not enough funds!\n💰 *${kit.name}* costs: *$${kit.price.toLocaleString()}*\n👛 Your wallet: *$${db[senderId].wallet.toLocaleString()}*`);
            const oldKit = db[senderId].activeHeistKit;
            db[senderId].wallet -= kit.price;
            db[senderId].activeHeistKit = kitKey; saveDB();
            return msg.reply(
                `${kit.emoji} *HEIST KIT PURCHASED!* ${kit.emoji}\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `🛡️ *${kit.name}* is now active!\n📋 ${kit.desc}\n\n` +
                (oldKit && oldKit !== kitKey ? `🔄 Replaced: *${HEIST_KITS[oldKit]?.name || oldKit}*\n` : '') +
                `💳 Paid: *-$${kit.price.toLocaleString()}*\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Robbers beware! 😤_`
            );
        }

        // ── .amazon buy bag <bagkey> ──────────────────────────────────────────
        if (sub === 'buy' && (args[2] || '').toLowerCase() === 'bag') {
            const bagKey = (args[3] || '').toLowerCase();
            const bag    = AMAZON_BAGS[bagKey];
            if (!bag) return msg.reply(`❌ Unknown bag! Valid: ${Object.keys(AMAZON_BAGS).map(k => `\`.amazon buy bag ${k}\``).join(', ')}`);
            if (db[senderId].wallet < bag.price) return msg.reply(`❌ Not enough funds!\n💰 *${bag.name}* costs: *$${bag.price.toLocaleString()}*\n👛 Your wallet: *$${db[senderId].wallet.toLocaleString()}*`);
            const oldBag = db[senderId].inventory.assignedBag || 'Basic Sack';
            db[senderId].wallet -= bag.price;
            db[senderId].inventory.assignedBag = bag.name; saveDB();
            return msg.reply(
                `${bag.emoji} *BAG PURCHASED!* ${bag.emoji}\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `👜 *${bag.name}* is now in your inventory!\n📋 ${bag.desc}\n\n` +
                `🔄 Replaced: *${oldBag}*\n💳 Paid: *-$${bag.price.toLocaleString()}*\n👛 Wallet: $${db[senderId].wallet.toLocaleString()}\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Check \`.inv\` to see your new bag! 🎒_`
            );
        }

        // ── .amazon kit — Check active kit ───────────────────────────────────
        if (sub === 'kit') {
            const kitKey = db[senderId].activeHeistKit;
            if (!kitKey) return msg.reply(`🛡️ You have no Heist Kit active!\nBuy one from \`.amazon\` 🛒`);
            const kit = HEIST_KITS[kitKey];
            return msg.reply(
                `🛡️ *YOUR ACTIVE HEIST KIT*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `${kit.emoji} *${kit.name}*\n📋 ${kit.desc}\n` +
                `🔐 Protection: *${Math.floor(kit.protectPct * 100)}%* damage blocked\n` +
                `⚡ Counter chance: *${Math.floor(kit.counterChance * 100)}%*\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Upgrade anytime at \`.amazon\`_`
            );
        }

        return msg.reply(`❌ Unknown subcommand. Try:\n• \`.amazon\` — Browse store\n• \`.amazon buy kit <type>\` — Buy protection kit\n• \`.amazon buy bag <brand>\` — Buy designer bag\n• \`.amazon kit\` — Check your active kit`);
    } catch (err) {
        console.error('Amazon store error:', err.message);
    }
});

client.once('ready', () => console.log(`✅ Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
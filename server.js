const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
// Используем нативный fetch (Node 18+)

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 });

const DATA_DIR = path.join(__dirname, 'data'), FONTS_DIR = path.join(__dirname, 'fonts');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR);

const read = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f))); } 
    catch(e) { 
        if(f === 'users.json') return [];
        if(f === 'fonts.json') return []; // Список имен файлов шрифтов
        return {}; 
    }
};
const write = (f, d) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(d, null, 2));

const init = (f, d) => { if (!fs.existsSync(path.join(DATA_DIR, f))) write(f, d); };
init('users.json', []); init('rooms.json', {}); init('fonts.json', []);

app.use('/fonts', express.static(FONTS_DIR));
app.use(express.static(__dirname));

const ADMIN_LOGIN = "Омикрун";
const ADMIN_PASS = "omicroon1326";

// --- AI LOGIC (Non-API / Web Automation Simulation via Free Proxy) ---
// Используем Pollinations.ai как прокси к Qwen/GPT для "real web interaction without key"
async function askNeuro(history) {
    // Формируем системный промпт
    const systemPrompt = `You are Neuro, an intelligent admin and AI assistant in a messenger called VOY. 
    You have admin rights. 
    Analyze the chat history.
    1. If the last user message violates safety or is spam/insult, reply ONLY with specific string: "DELETE_REQ".
    2. Otherwise, answer helpfully and briefly.
    3. You can read constructed languages (conlangs) contextually.`;
    
    const messages = [
        { role: "system", content: systemPrompt },
        ...history.map(m => ({ role: m.user === 'Neuro' ? 'assistant' : 'user', content: `${m.user}: ${m.text}` }))
    ];

    try {
        const response = await fetch('https://text.pollinations.ai/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: messages,
                model: 'qwen', // Используем Qwen как просили
                seed: Math.floor(Math.random() * 1000)
            })
        });
        const text = await response.text();
        return text;
    } catch (e) {
        console.error("AI Error:", e);
        return "Ошибка связи с нейросетью.";
    }
}

// Утилиты
const getPublicRooms = (rooms) => {
    const pub = {};
    for(let k in rooms) if(!rooms[k].isDm) pub[k] = rooms[k];
    return pub;
};
const getUserDMs = (rooms, username) => {
    const dms = {};
    for(let k in rooms) if(rooms[k].isDm && rooms[k].participants.includes(username)) dms[k] = rooms[k];
    return dms;
};

io.on('connection', (socket) => {
    let me = null;
    let isAdmin = false;

    // --- Global Fonts ---
    socket.on('request_global_fonts', () => {
        const fonts = read('fonts.json');
        // Возвращаем пути
        socket.emit('fonts_list', fonts.map(f => `/fonts/${f}`));
    });

    socket.on('admin_upload_font', (d) => {
        if(!isAdmin) return;
        const fname = `global_${Date.now()}_${d.name.replace(/[^a-z0-9.]/gi, '_')}`;
        fs.writeFileSync(path.join(FONTS_DIR, fname), Buffer.from(d.file.split(',')[1], 'base64'));
        const list = read('fonts.json');
        list.push(fname);
        write('fonts.json', list);
        io.emit('fonts_list', list.map(f => `/fonts/${f}`)); // Обновляем у всех
        socket.emit('alert', 'Шрифт загружен глобально!');
    });

    // --- Auth ---
    socket.on('register', (d) => {
        const u = read('users.json');
        if (u.find(x => x.username === d.username)) return socket.emit('error', 'Ник занят!');
        if (d.username === ADMIN_LOGIN || d.username === 'System' || d.username === 'Neuro') return socket.emit('error', 'Ник зарезервирован.');
        u.push({ username: d.username, password: d.password, bio: "", avatar: '', banned: false });
        write('users.json', u); socket.emit('alert', 'Готово! Войдите.');
    });

    socket.on('login', (d) => {
        if (d.username === ADMIN_LOGIN && d.password === ADMIN_PASS) {
            me = { username: ADMIN_LOGIN, avatar: '', bio: 'System Administrator' };
            isAdmin = true;
        } else {
            const users = read('users.json');
            const user = users.find(x => x.username === d.username && x.password === d.password);
            if (!user) return socket.emit('error', 'Ошибка входа');
            if (user.banned) return socket.emit('error', 'ВЫ ЗАБАНЕНЫ.');
            me = user; isAdmin = false;
        }

        socket.emit('auth_ok', { ...me, isAdmin });
        const rooms = read('rooms.json');
        socket.emit('update_rooms', getPublicRooms(rooms));
        socket.emit('update_dms', getUserDMs(rooms, me.username));
        socket.join('lobby');
    });

    // --- Rooms ---
    socket.on('create_room', (d) => {
        if(!me) return;
        const r = read('rooms.json'), id = 'room_' + Date.now();
        r[id] = { 
            id, title: d.title, owner: me.username, 
            password: d.password || null, hasPass: !!d.password, 
            mode: d.mode, msgs: [], pinned: null, bannedWords: [],
            isDm: false,
            admins: [], // Локальные админы
            aiActive: false // Нейросеть выключена по умолчанию
        };
        write('rooms.json', r); 
        io.to('lobby').emit('update_rooms', getPublicRooms(r));
    });

    socket.on('join_room', (d) => {
        const rooms = read('rooms.json');
        const r = rooms[d.id];
        if(!r) return;
        if(r.isDm && !isAdmin && !r.participants.includes(me.username)) return socket.emit('error', 'Приватный чат.');
        if(!r.isDm && r.password && r.password !== d.password && !isAdmin) return socket.emit('error', 'Неверный пароль!');
        
        socket.join(d.id);
        const data = {...r}; delete data.password;
        if(r.isDm) {
            const other = r.participants.find(u => u !== me.username) || me.username;
            data.title = other;
        }
        socket.emit('room_history', data);
    });

    socket.on('delete_room', (roomId) => {
        if(!me) return;
        const rooms = read('rooms.json'), r = rooms[roomId];
        if (r && (r.owner === me.username || isAdmin)) {
            delete rooms[roomId]; write('rooms.json', rooms);
            io.to('lobby').emit('update_rooms', getPublicRooms(rooms));
            io.to(roomId).emit('room_closed'); 
        }
    });

    // --- AI Control ---
    socket.on('toggle_ai', (roomId) => {
        if(!me) return;
        const rooms = read('rooms.json'), r = rooms[roomId];
        if(!r || r.isDm) return;
        
        const isRoomAdmin = isAdmin || r.owner === me.username || r.admins.includes(me.username);
        if(!isRoomAdmin) return socket.emit('error', 'Нет прав на включение AI.');

        r.aiActive = !r.aiActive;
        write('rooms.json', rooms);
        
        // Уведомление в чат
        const status = r.aiActive ? "включилась и читает чат." : "отключилась.";
        const sysMsg = createMsg('Neuro', `Я ${status}`, 'text', r.owner);
        r.msgs.push(sysMsg);
        
        io.to(roomId).emit('new_msg', sysMsg);
        io.to('lobby').emit('update_rooms', getPublicRooms(rooms)); // Обновить значок
        io.to(roomId).emit('update_room_meta', { roomId, aiActive: r.aiActive });
    });

    // --- Messaging ---
    socket.on('send_msg', async (d) => {
        if(!me) return;
        const rooms = read('rooms.json'), r = rooms[d.roomId];
        if(!r) return;

        // Banned words check
        if(d.type === 'text') {
            const badWord = r.bannedWords.find(w => d.text.toLowerCase().includes(w.toLowerCase()));
            if(badWord) return socket.emit('error', `Слово "${badWord}" запрещено!`);
        }
        
        // Commands
        if(d.type === 'text' && d.text.startsWith('!')) {
            // !админ(User) - назначение админа
            const adminMatch = d.text.match(/^!админ\((.+)\)$/);
            if(adminMatch) {
                if(r.owner !== me.username && !isAdmin) return socket.emit('error', 'Только владелец комнаты может назначать админов.');
                const target = adminMatch[1].trim();
                if(!r.admins.includes(target)) {
                    r.admins.push(target);
                    write('rooms.json', rooms);
                    const msg = createMsg('System', `Пользователь ${target} теперь админ комнаты.`, 'text', r.owner);
                    r.msgs.push(msg); io.to(d.roomId).emit('new_msg', msg);
                }
                return;
            }

            // !запрет(слово)
            const banMatch = d.text.match(/^!запрет\((.+)\)$/);
            if(banMatch) {
                if(r.owner !== me.username && !isAdmin && !r.admins.includes(me.username)) return socket.emit('error', 'Нет прав.');
                r.bannedWords.push(banMatch[1].trim()); write('rooms.json', rooms);
                return;
            }

            // !факт(текст)
            const factMatch = d.text.match(/^!факт\((.+)\)$/);
            if(factMatch) {
                const query = factMatch[1].trim();
                const sysMsg = createMsg('System', `🔍 <a href="https://www.google.com/search?q=${query}" target="_blank">Google: ${query}</a>`, 'text', r.owner);
                r.msgs.push(sysMsg); io.to(d.roomId).emit('new_msg', sysMsg);
                return;
            }

            // !нейро (алиас для включения, если админ)
            if(d.text.trim() === '!нейро') {
                if(r.owner === me.username || isAdmin || r.admins.includes(me.username)) {
                    // Trigger toggle
                    r.aiActive = !r.aiActive;
                    write('rooms.json', rooms);
                    const status = r.aiActive ? "включилась." : "отключилась.";
                    const m = createMsg('Neuro', `Я ${status}`, 'text', r.owner);
                    r.msgs.push(m); io.to(d.roomId).emit('new_msg', m);
                    io.to(d.roomId).emit('update_room_meta', { roomId: d.roomId, aiActive: r.aiActive });
                    return;
                }
            }
        }

        if (r.mode === 'channel' && r.owner !== me.username && !isAdmin && !r.admins.includes(me.username)) return;

        const m = createMsg(me.username, d.text, d.type, r.owner, d.file, d.replyTo);
        r.msgs.push(m); 
        if(r.msgs.length > 200) r.msgs.shift();
        write('rooms.json', rooms); 
        io.to(d.roomId).emit('new_msg', m);

        // --- AI PROCESS ---
        if(r.aiActive && !r.isDm && d.type === 'text') {
            // Берем последние 10 сообщений для контекста
            const history = r.msgs.slice(-10);
            
            // Вызываем AI
            const aiAnswer = await askNeuro(history);
            
            if(aiAnswer.includes("DELETE_REQ")) {
                // AI решил удалить сообщение
                r.msgs = r.msgs.filter(x => x.id !== m.id);
                write('rooms.json', rooms);
                io.to(d.roomId).emit('msg_deleted', m.id);
                const warning = createMsg('Neuro', `Сообщение от ${m.user} удалено (нарушение).`, 'text', r.owner);
                r.msgs.push(warning);
                io.to(d.roomId).emit('new_msg', warning);
            } else {
                // AI отвечает
                const botMsg = createMsg('Neuro', aiAnswer, 'text', r.owner);
                r.msgs.push(botMsg);
                write('rooms.json', rooms);
                io.to(d.roomId).emit('new_msg', botMsg);
            }
        }
    });

    function createMsg(user, text, type, roomOwner, file = null, replyTo = null) {
        return {
            id: Date.now() + Math.random(), 
            user, text, type, file, 
            time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}), 
            roomOwner, replyTo
        };
    }

    // --- Message Management ---
    socket.on('delete_msg', (d) => {
        const rooms = read('rooms.json'), r = rooms[d.roomId];
        const isLocalAdmin = r.admins && r.admins.includes(me.username);
        if(r && (r.owner === me.username || isAdmin || isLocalAdmin || r.isDm)) {
            r.msgs = r.msgs.filter(m => m.id != d.msgId);
            if(r.pinned && r.pinned.id == d.msgId) r.pinned = null;
            write('rooms.json', rooms); io.to(d.roomId).emit('msg_deleted', d.msgId);
            if(!r.pinned) io.to(d.roomId).emit('update_pin', null);
        }
    });

    socket.on('pin_msg', (d) => {
        const rooms = read('rooms.json'), r = rooms[d.roomId];
        const isLocalAdmin = r.admins && r.admins.includes(me.username);
        if(r && (r.owner === me.username || isAdmin || isLocalAdmin)) {
            r.pinned = d.msgId ? r.msgs.find(m => m.id == d.msgId) : null;
            write('rooms.json', rooms); io.to(d.roomId).emit('update_pin', r.pinned);
        }
    });

    // --- Users ---
    socket.on('search_users', (q) => socket.emit('search_results', read('users.json').filter(u => u.username.toLowerCase().includes(q.toLowerCase())).map(u=>({username:u.username, avatar:u.avatar}))));
    
    socket.on('get_other_profile', (name) => {
        if(name === ADMIN_LOGIN) return socket.emit('show_other_profile', { username: ADMIN_LOGIN, bio: "SysAdmin", avatar: "" });
        const u = read('users.json').find(x => x.username === name);
        if(u) socket.emit('show_other_profile', { username: u.username, bio: u.bio, avatar: u.avatar });
    });

    socket.on('ban_user', (name) => {
        if(!isAdmin) return;
        const users = read('users.json'), idx = users.findIndex(u => u.username === name);
        if(idx !== -1) { users[idx].banned = true; write('users.json', users); io.emit('alert', `Пользователь ${name} забанен.`); }
    });

    socket.on('update_profile', (d) => {
        if(!me || isAdmin) return;
        const u = read('users.json'), idx = u.findIndex(x => x.username === me.username);
        u[idx].bio = d.bio || u[idx].bio; u[idx].avatar = d.avatar || u[idx].avatar;
        write('users.json', u); me = u[idx]; socket.emit('auth_ok', me);
    });

    socket.on('start_dm', (target) => {
        if(!me) return;
        const rooms = read('rooms.json'), parts = [me.username, target].sort(), id = `dm_${parts.join('_')}`;
        if(!rooms[id]) { rooms[id] = { id, title:target, participants:parts, isDm:true, msgs:[], owner:'sys', admins:[] }; write('rooms.json', rooms); }
        socket.emit('dm_ready', id);
    });

    socket.on('refresh_lists', () => { if(me) { const r = read('rooms.json'); socket.emit('update_rooms', getPublicRooms(r)); socket.emit('update_dms', getUserDMs(r, me.username)); }});
});

server.listen(3000, () => console.log('VOY v4.0 AI Edition running on 3000'));
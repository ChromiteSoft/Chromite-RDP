// main.js - Основний потік
// Відповідає за UI, LocalStorage, відкриття TCPSocket, передачу Streams у WebWorker.

// --- UI Elements ---
const serverListEl = document.getElementById('serverList');
const newNameInput = document.getElementById('newName');
const newIpInput = document.getElementById('newIp');
const addServerBtn = document.getElementById('addServerBtn');
const activeServerDisplay = document.getElementById('activeServerDisplay');
const statusPanel = document.getElementById('statusPanel');
const statusText = document.getElementById('statusText');
const disconnectBtn = document.getElementById('disconnectBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const toggleSbBtn = document.getElementById('toggleSbBtn');
const sidebar = document.getElementById('sidebar');
const splash = document.getElementById('splash');
const canvas = document.getElementById('rdpDisplay');
const ctx = canvas.getContext('2d');

let servers = JSON.parse(localStorage.getItem('rdp_servers')) || [];
let rdpWorker = null;
let currentSocket = null;
let activeIp = null;

// --- Управління серверами (LocalStorage) ---
function renderServerList() {
    serverListEl.innerHTML = '';
    servers.forEach((srv, index) => {
        const item = document.createElement('div');
        item.className = 'server-item';

        const info = document.createElement('div');
        info.className = 'server-info';
        info.innerHTML = `<span class="server-name">${srv.name}</span><span class="server-ip">${srv.ip}</span>`;

        const delBtn = document.createElement('button');
        delBtn.className = 'delete-btn';
        delBtn.innerHTML = '✕';
        delBtn.title = "Видалити";
        delBtn.onclick = (e) => {
            e.stopPropagation();
            servers.splice(index, 1);
            saveServers();
        };

        item.onclick = () => initConnection(srv);

        item.appendChild(info);
        item.appendChild(delBtn);
        serverListEl.appendChild(item);
    });
}

function saveServers() {
    localStorage.setItem('rdp_servers', JSON.stringify(servers));
    renderServerList();
}

addServerBtn.onclick = () => {
    const name = newNameInput.value.trim();
    const ip = newIpInput.value.trim();
    if (!name || !ip) return alert("Введіть назву та IP адресу");
    servers.push({ name, ip });
    newNameInput.value = '';
    newIpInput.value = '';
    saveServers();
};

renderServerList(); // Initial render

// --- UI Interactions ---

toggleSbBtn.onclick = () => sidebar.classList.toggle('hidden');

fullscreenBtn.onclick = () => {
    if (!document.fullscreenElement) {
        document.body.requestFullscreen().catch(err => {
            alert(`Неможливо перейти в повноекранний режим: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
};

document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        document.body.classList.add('fullscreen');
        resizeCanvasToWindow();
    } else {
        document.body.classList.remove('fullscreen');
    }
});

// Дозволяємо канвасу повністю зайняти екран коли у фулскріні
function resizeCanvasToWindow() {
    if (rdpWorker && document.fullscreenElement) {
        // Ми можемо відправити команду зміни розміру сесії до WASM Worker'а,
        // Якщо IronRDP підтримує динамічний resize()
        // rdpWorker.postMessage({type: "RESIZE", width: window.innerWidth, height: window.innerHeight});
    }
}
window.addEventListener('resize', () => {
    if (document.fullscreenElement) resizeCanvasToWindow();
});

function setUIStatus(msg, state = 'warning') {
    statusText.textContent = msg;
    statusPanel.className = `status-${state}`;
}

// --- RDP Connection Logic ---

async function initConnection(server) {
    if (currentSocket) disconnect(); // Clean up if already connected

    activeIp = server.ip;
    activeServerDisplay.textContent = `${server.name} (${server.ip})`;
    splash.style.display = 'none';
    canvas.style.display = 'block';
    disconnectBtn.style.display = 'flex';

    if (!('TCPSocket' in window)) {
        return setUIStatus("TCPSocket API відсутній!", 'error');
    }

    setUIStatus('Відкриття сокета...', 'warning');

    try {
        currentSocket = new TCPSocket(activeIp, 3389);
        const { readable, writable } = await currentSocket.opened;

        startWorker(activeIp, readable, writable);
        setupInputEvents();

    } catch (err) {
        setUIStatus(`Помилка TCP: ${err.message}`, 'error');
        console.error(err);
    }
}

function startWorker(ip, readable, writable) {
    if (rdpWorker) rdpWorker.terminate();

    rdpWorker = new Worker('rdp_worker.js', { type: "module" });

    rdpWorker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
            case 'STATUS':
                setUIStatus(msg.text, 'warning');
                break;
            case 'CONNECTED':
                setUIStatus("Підключено", 'connected');
                if (!document.body.classList.contains('fullscreen')) {
                    sidebar.classList.add('hidden'); // Автоматично ховати сайдбар при підключенні
                }
                break;
            case 'FRAME':
                renderFrame(msg.buffer, msg.width, msg.height);
                break;
            case 'ERROR':
                setUIStatus(`Помилка RDP: ${msg.error}`, 'error');
                disconnectToSplash();
                break;
        }
    };

    rdpWorker.postMessage({
        type: 'START_SESSION',
        ip: ip,
        readable: readable,
        writable: writable
    }, [readable, writable]);
}

function renderFrame(buffer, width, height) {
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    const imgData = new ImageData(new Uint8ClampedArray(buffer), width, height);
    ctx.putImageData(imgData, 0, 0);
}

function disconnect() {
    if (currentSocket) {
        currentSocket.close().catch(console.error);
        currentSocket = null;
    }
    if (rdpWorker) {
        rdpWorker.terminate();
        rdpWorker = null;
    }
    removeInputEvents();
}

function disconnectToSplash() {
    disconnect();
    setUIStatus('Відключено', 'warning');
    activeServerDisplay.textContent = 'Оберіть сервер';
    disconnectBtn.style.display = 'none';
    canvas.style.display = 'none';
    splash.style.display = 'flex';
    sidebar.classList.remove('hidden');
}

disconnectBtn.onclick = disconnectToSplash;

// --- Input Handling ---

function handleMouse(e) {
    if (!rdpWorker) return;
    const rect = canvas.getBoundingClientRect();

    // Враховуємо реальні пікселі стосовно відображеного CSS розміру
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    let state = 0; // 0 - move, 1 - down, 2 - up
    if (e.type === 'mousedown') state = 1;
    if (e.type === 'mouseup') state = 2;

    rdpWorker.postMessage({ type: 'MOUSE', x, y, button: e.button, state });
}

function handleKey(e) {
    if (!rdpWorker) return;
    e.preventDefault();
    rdpWorker.postMessage({
        type: 'KEY',
        code: e.code,
        key: e.key,
        isDown: e.type === 'keydown'
    });
}

function setupInputEvents() {
    canvas.addEventListener('mousemove', handleMouse);
    canvas.addEventListener('mousedown', handleMouse);
    canvas.addEventListener('mouseup', handleMouse);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', handleKey);
    window.addEventListener('keyup', handleKey);
}

function removeInputEvents() {
    canvas.removeEventListener('mousemove', handleMouse);
    canvas.removeEventListener('mousedown', handleMouse);
    canvas.removeEventListener('mouseup', handleMouse);
    canvas.removeEventListener('contextmenu', e => e.preventDefault());
    window.removeEventListener('keydown', handleKey);
    window.removeEventListener('keyup', handleKey);
}

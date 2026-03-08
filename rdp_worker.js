import init, { SessionBuilder, DesktopSize, DeviceEvent, InputTransaction } from './ironrdp_wasm.js';

let tcpReader = null;
let tcpWriter = null;
let currentSession = null;
let isSessionActive = false;

// Хитрість: ironrdp-wasm призначений для підключення через WebSocket-проксі.
// Оскільки ми хочемо використовувати прямий TCPSocket (Direct Sockets API),
// ми тимчасово перевизначимо глобальний об'єкт WebSocket в контексті цього Worker-а.
class MockWebSocket {
    constructor(url) {
        this.url = url;
        this.binaryType = "arraybuffer";
        this.readyState = 0; // CONNECTING

        // Відразу "відкриваємо" сокет, бо TCPSocket вже відкритий на стороні main.js
        setTimeout(() => {
            this.readyState = 1; // OPEN
            if (this.onopen) this.onopen(new Event('open'));
            this._pumpTCP();
        }, 10);
    }

    send(data) {
        // ironrdp-wasm відправляє Uint8Array.
        if (tcpWriter && isSessionActive) {
            tcpWriter.write(data).catch(e => {
                console.error("Помилка відправки TCP:", e);
                this._triggerError(e);
            });
        }
    }

    close() {
        this.readyState = 3; // CLOSED
        isSessionActive = false;
        if (this.onclose) this.onclose(new Event('close'));
    }

    async _pumpTCP() {
        if (!tcpReader) return;
        try {
            while (isSessionActive) {
                const { value, done } = await tcpReader.read(); // value - Uint8Array
                if (done) {
                    this.close();
                    break;
                }

                // ironrdp-wasm очікує ArrayBuffer або Uint8Array у події `message` 'data'
                if (this.onmessage) {
                    this.onmessage({ data: value.buffer || value });
                }
            }
        } catch (err) {
            console.error("Помилка читання TCP потоку:", err);
            this._triggerError(err);
        }
    }

    _triggerError(err) {
        this.readyState = 3;
        if (this.onerror) this.onerror(new Event('error'));
        if (this.onclose) this.onclose(new Event('close'));
    }
}

// Перевизначаємо реальний WebSocket нашим Mock'ом для TCPSocket
globalThis.WebSocket = MockWebSocket;

self.onmessage = async (e) => {
    const msg = e.data;
    switch (msg.type) {
        case 'START_SESSION':
            await initRdpSession(msg.ip, msg.readable, msg.writable);
            break;
        case 'MOUSE':
            if (isSessionActive && currentSession) {
                const transaction = new InputTransaction();
                if (msg.state === 0) transaction.addEvent(DeviceEvent.mouseMove(msg.x, msg.y));
                if (msg.state === 1) transaction.addEvent(DeviceEvent.mouseButtonPressed(msg.button));
                if (msg.state === 2) transaction.addEvent(DeviceEvent.mouseButtonReleased(msg.button));
                try { currentSession.applyInputs(transaction); } catch (err) { console.error("Ввід MOUSE:", err); }
            }
            break;
        case 'KEY':
            if (isSessionActive && currentSession) {
                const transaction = new InputTransaction();
                // Для клавіатури потрібне перетворення кодів, але для базового демо
                // можна використати unicode Pressed/Released або прості сканокоди:
                // transaction.addEvent(msg.isDown ? DeviceEvent.keyPressed(scancode) : DeviceEvent.keyReleased(scancode));
                try { currentSession.applyInputs(transaction); } catch (err) { console.error("Ввід KEY:", err); }
            }
            break;
    }
};

async function initRdpSession(ip, readableStream, writableStream) {
    try {
        self.postMessage({ type: 'STATUS', text: 'Ініціалізація WASM...' });

        // Завантаження WASM бібліотеки ironrdp
        await init('./ironrdp_wasm_bg.wasm');

        self.postMessage({ type: 'STATUS', text: 'WASM завантажено. Підготовка RDP клієнта...' });

        tcpReader = readableStream.getReader();
        tcpWriter = writableStream.getWriter();
        isSessionActive = true;

        // Налаштовуємо розміри екрану. Це можна буде змінити на динамічні пізніше.
        const size = new DesktopSize(1024, 768);

        // Будуємо підключення
        let builder = new SessionBuilder()
            .proxyAddress("ws://tcp-socket-transparent-proxy") // Використає наш MockWebSocket!
            .destination(`${ip}:3389`) // RDP ip
            .desktopSize(size)
            .username('Administrator') // Фіксуємо ім'я користувача або потрібно передати з UI
            .password(''); // У RDP можна зайти без пароля якщо налаштовано, або додати поле в UI

        self.postMessage({ type: 'STATUS', text: 'З\'єднання та Handshake...' });

        // Connect запускає процес і використовує WebSocket(proxyAddress)
        currentSession = await builder.connect();

        self.postMessage({ type: 'CONNECTED' });

        // IronRDP Web: після підключення треба викликати .run() щоб обробляти графіку
        // Однак canvas renderCallback в WASM наразі не передає нам ArrayBuffer напряму,
        // він очікує HTMLCanvasElement, який недоступний у WebWorker.
        // Тому зазвичай proxy-worker передає OffscreenCanvas якщо підтримується,
        // або використовується fallback з requestAnimationFrame у Main Thread.

        const terminator = await currentSession.run();
        self.postMessage({ type: 'ERROR', error: `Сесія завершена: ${terminator.reason()}` });

    } catch (err) {
        self.postMessage({ type: 'ERROR', error: err.toString() });
        cleanup();
    }
}

function cleanup() {
    isSessionActive = false;
    if (tcpReader) tcpReader.cancel().catch(() => { });
    if (tcpWriter) tcpWriter.close().catch(() => { });
    if (currentSession) {
        currentSession.free();
        currentSession = null;
    }
}

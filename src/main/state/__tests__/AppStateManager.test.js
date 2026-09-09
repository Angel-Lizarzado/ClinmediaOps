// Tests del broadcast de AppStateManager.
//
// El throttle tenía una guarda rota (`if (this._broadcastThrottled && ...)`
// evaluaba el propio método, siempre truthy) y no tenía trailing edge: el
// último cambio dentro de la ventana de 50ms se descartaba para siempre.
// Eso desincronizaba la UI al final de cada corrida.

const enviados = [];

const ventanaFake = {
  isDestroyed: () => false,
  webContents: {
    send: (canal, payload) => enviados.push({ canal, payload }),
  },
};

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [ventanaFake] },
}));

const { AppStateManager, DEFAULT_STATE } = require('../AppStateManager');

beforeEach(() => {
  enviados.length = 0;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('DEFAULT_STATE', () => {
  test('declara todos los módulos que el código usa por nombre', () => {
    // 'cloudflare' y 'storageMetrics' faltaban: update() los rechazaba con
    // "Módulo desconocido" y el estado se perdía en silencio.
    for (const modulo of [
      'extraction', 'deployment', 'syncdns', 'cloudflare', 'ssl',
      'provisioning', 'malware', 'sshConnection', 'sourcesync', 'cms',
      'storageMetrics',
    ]) {
      expect(DEFAULT_STATE[modulo]).toBeDefined();
    }
  });

  test('el constructor deriva su estado de DEFAULT_STATE', () => {
    const appState = new AppStateManager();
    expect(Object.keys(appState.getState()).sort()).toEqual(Object.keys(DEFAULT_STATE).sort());
  });
});

describe('throttle del broadcast', () => {
  test('el primer update se emite de inmediato', () => {
    const appState = new AppStateManager();
    appState.update('extraction', { currentProgress: 1 });
    expect(enviados).toHaveLength(1);
  });

  test('una ráfaga se colapsa pero el último estado SIEMPRE llega', () => {
    const appState = new AppStateManager();

    // 10 updates seguidos dentro de la misma ventana de 50ms
    for (let i = 1; i <= 10; i++) {
      appState.update('extraction', { currentProgress: i });
    }

    // Se emitió el primero; el resto está agendado, no descartado
    expect(enviados).toHaveLength(1);

    jest.advanceTimersByTime(60);

    expect(enviados.length).toBeGreaterThan(1);
    const ultimo = enviados[enviados.length - 1];
    expect(ultimo.canal).toBe('state:update');
    expect(ultimo.payload.extraction.currentProgress).toBe(10);
  });

  test('dispose() cancela el broadcast pendiente', () => {
    const appState = new AppStateManager();
    appState.update('extraction', { currentProgress: 1 });
    appState.update('extraction', { currentProgress: 2 });

    const antes = enviados.length;
    appState.dispose();
    jest.advanceTimersByTime(200);

    expect(enviados).toHaveLength(antes);
  });
});

describe('update()', () => {
  test('acepta el módulo cloudflare', () => {
    const appState = new AppStateManager();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    appState.update('cloudflare', { isRunning: true, currentDomain: 'ejemplo.com' });

    expect(warn).not.toHaveBeenCalled();
    expect(appState.getState('cloudflare').currentDomain).toBe('ejemplo.com');
    warn.mockRestore();
  });

  test('sigue avisando de un módulo que no existe', () => {
    const appState = new AppStateManager();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    appState.update('inventado', { isRunning: true });

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// Tests del pool de conexiones SSH.
//
// El bug: solo executeCommand reiniciaba el timer de inactividad. Una descarga
// o subida larga no emite comandos, así que el idle timeout de 3 minutos le
// cerraba la conexión por abajo a mitad de transferencia.

jest.mock('ssh2', () => ({ Client: class {} }));
jest.mock('../config-manager', () => ({ getConfigManager: () => ({ getConfig: () => ({}) }) }));

const { SshService } = (() => {
  const mod = require('../ssh-service');
  // El módulo exporta el singleton; se toma la clase desde su prototipo.
  return { SshService: mod.SshService || Object.getPrototypeOf(mod.getSshService()).constructor };
})();

const IDLE_MS = 180000;

/** Cliente SSH falso: solo necesita ser una identidad y poder cerrarse. */
function makeClient(nombre) {
  return { nombre, ended: false, end() { this.ended = true; } };
}

/** Registra una entrada en el pool sin abrir una conexión real. */
function seedPool(svc, cacheKey, client) {
  svc.connectionPool.set(cacheKey, { client, timer: null, active: 0 });
  svc._resetIdleTimer(cacheKey);
}

let svc;

beforeEach(() => {
  jest.useFakeTimers();
  svc = new SshService();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('idle timeout del pool', () => {
  test('cierra una conexión que quedó ociosa', () => {
    const client = makeClient('a');
    seedPool(svc, 'host:22:root', client);

    jest.advanceTimersByTime(IDLE_MS + 1000);

    expect(client.ended).toBe(true);
    expect(svc.connectionPool.has('host:22:root')).toBe(false);
  });

  test('NO cierra la conexión mientras hay una operación larga en curso', () => {
    const client = makeClient('a');
    seedPool(svc, 'host:22:root', client);

    svc._beginPoolActivity(client);
    // Una transferencia que dura mucho más que el idle timeout
    jest.advanceTimersByTime(IDLE_MS * 3);

    expect(client.ended).toBe(false);
    expect(svc.connectionPool.has('host:22:root')).toBe(true);
  });

  test('rearma el timeout al terminar la operación', () => {
    const client = makeClient('a');
    seedPool(svc, 'host:22:root', client);

    svc._beginPoolActivity(client);
    jest.advanceTimersByTime(IDLE_MS * 2);
    expect(client.ended).toBe(false);

    svc._endPoolActivity(client);
    jest.advanceTimersByTime(IDLE_MS + 1000);
    expect(client.ended).toBe(true);
  });

  test('soporta operaciones anidadas: cierra recién cuando terminan todas', () => {
    const client = makeClient('a');
    seedPool(svc, 'host:22:root', client);

    svc._beginPoolActivity(client);
    svc._beginPoolActivity(client);

    svc._endPoolActivity(client);
    jest.advanceTimersByTime(IDLE_MS * 2);
    expect(client.ended).toBe(false); // todavía queda una activa

    svc._endPoolActivity(client);
    jest.advanceTimersByTime(IDLE_MS + 1000);
    expect(client.ended).toBe(true);
  });
});

describe('_withPoolActivity', () => {
  test('protege la operación y libera el guard al terminar bien', async () => {
    const client = makeClient('a');
    seedPool(svc, 'host:22:root', client);

    const promesa = svc._withPoolActivity(client, async () => {
      jest.advanceTimersByTime(IDLE_MS * 2);
      return 'listo';
    });

    await expect(promesa).resolves.toBe('listo');
    expect(client.ended).toBe(false);
    expect(svc.connectionPool.get('host:22:root').active).toBe(0);
  });

  test('libera el guard también cuando la operación falla', async () => {
    const client = makeClient('a');
    seedPool(svc, 'host:22:root', client);

    await expect(
      svc._withPoolActivity(client, async () => { throw new Error('transferencia cortada'); })
    ).rejects.toThrow('transferencia cortada');

    expect(svc.connectionPool.get('host:22:root').active).toBe(0);
  });

  test('no rompe con un cliente que no está en el pool', async () => {
    const suelto = makeClient('suelto');
    await expect(svc._withPoolActivity(suelto, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('_removeCachedClient', () => {
  test('no borra la entrada nueva cuando cierra la conexión vieja', () => {
    const viejo = makeClient('viejo');
    const nuevo = makeClient('nuevo');
    seedPool(svc, 'host:22:root', viejo);
    seedPool(svc, 'host:22:root', nuevo); // reconexión sobre la misma clave

    // Llega tarde el 'close' del cliente viejo
    svc._removeCachedClient('host:22:root', viejo);

    expect(svc.connectionPool.get('host:22:root').client).toBe(nuevo);
  });
});

describe('disconnectAll', () => {
  test('cierra también las conexiones del pool y limpia sus timers', async () => {
    const a = makeClient('a');
    const b = makeClient('b');
    seedPool(svc, 'host1:22:root', a);
    seedPool(svc, 'host2:22:root', b);

    await svc.disconnectAll();

    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(svc.connectionPool.size).toBe(0);
  });
});

'use strict';

const {
  runStep6,
  BLACKLIST_SLUGS,
  liftFileModsLock,
  restoreFileModsLock,
  applyBlacklist,
} = require('../step6-plugin');

describe('step6-plugin', () => {
  let mockCtx;
  let executedCmds;

  beforeEach(() => {
    executedCmds = [];
    mockCtx = {
      webRoot: '/var/www/vhosts/ejemplo.test/httpdocs',
      sysUser: 'usuario_vhost',
      totalSteps: 10,
      emit: jest.fn(),
      run: jest.fn(async (cmd) => {
        executedCmds.push(cmd);
        if (cmd.includes('grep -q "DISALLOW_FILE_MODS"')) {
          return { code: 0, stdout: 'LOCKED:/var/www/vhosts/ejemplo.test/httpdocs/wp-config.php\n' };
        }
        if (cmd.includes('plugin is-installed')) {
          if (cmd.includes('duplicate-page')) {
            return { code: 0, stdout: 'installed' };
          }
          return { code: 1, stdout: 'Not installed' };
        }
        if (cmd.includes('RESTORED')) {
          return { code: 0, stdout: 'RESTORED' };
        }
        if (cmd.includes('unzip -Z1')) {
          return { code: 0, stdout: 'elementor-pro/index.php\n' };
        }
        return { code: 0, stdout: '' };
      }),
    };
  });

  describe('liftFileModsLock & restoreFileModsLock', () => {
    it('detects lock and comments it out', async () => {
      const log = { info: jest.fn(), detail: jest.fn(), warn: jest.fn(), success: jest.fn() };
      const lockedPath = await liftFileModsLock(mockCtx, log);

      expect(lockedPath).toBe('/var/www/vhosts/ejemplo.test/httpdocs/wp-config.php');
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Candado detectado'));
      expect(executedCmds.some((c) => c.includes('KRAKEN_MODS_TEMP'))).toBe(true);
    });

    it('restores lock when restoreFileModsLock is called', async () => {
      const log = { info: jest.fn(), detail: jest.fn(), warn: jest.fn(), success: jest.fn() };
      await restoreFileModsLock(mockCtx, '/var/www/vhosts/ejemplo.test/httpdocs/wp-config.php', log);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Restaurando candado'));
      expect(executedCmds.some((c) => c.includes('KRAKEN_MODS_TEMP'))).toBe(true);
      expect(log.success).toHaveBeenCalledWith(expect.stringContaining('restaurado'));
    });
  });

  describe('applyBlacklist', () => {
    it('deactivates and deletes installed blacklisted plugins, and cleans directories', async () => {
      const log = { info: jest.fn(), detail: jest.fn(), warn: jest.fn(), success: jest.fn() };
      await applyBlacklist(mockCtx, log);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`purgando ${BLACKLIST_SLUGS.length}`));
      // Debe haber ejecutado delete para duplicate-page
      expect(executedCmds.some((c) => c.includes('plugin delete duplicate-page'))).toBe(true);
    });

    it('skips excluded plugins when excludedSlugs is provided', async () => {
      const log = { info: jest.fn(), detail: jest.fn(), warn: jest.fn(), success: jest.fn() };
      executedCmds.length = 0;
      await applyBlacklist(mockCtx, log, ['gdpr-cookie-compliance']);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`purgando ${BLACKLIST_SLUGS.length - 1}`));
      expect(log.detail).toHaveBeenCalledWith(expect.stringContaining('gdpr-cookie-compliance → conservado'));
      expect(executedCmds.some((c) => c.includes('gdpr-cookie-compliance'))).toBe(false);
    });
  });

  describe('runStep6 lifecycle', () => {
    it('lifts lock before installing, installs plugins, deletes blacklisted plugins, and restores lock in finally block', async () => {
      await runStep6(mockCtx, {
        elementorZipRemotePath: '/tmp/elementor-pro.zip',
        elementorLicenseKey: 'TEST-LICENSE-KEY',
      });

      // 1. Levantó el candado
      expect(executedCmds.some((c) => c.includes('KRAKEN_MODS_TEMP') && c.includes('DISALLOW_FILE_MODS'))).toBe(true);
      // 2. Extrajo e instaló Elementor Pro
      expect(executedCmds.some((c) => c.includes('unzip -o -q "/tmp/elementor-pro.zip"'))).toBe(true);
      // 3. Activó licencia
      expect(executedCmds.some((c) => c.includes('elementor-pro license activate \'TEST-LICENSE-KEY\''))).toBe(true);
      // 4. Purgó blacklist
      expect(executedCmds.some((c) => c.includes('plugin delete duplicate-page'))).toBe(true);
      // 5. Restauró el candado
      expect(executedCmds.some((c) => c.includes('KRAKEN_MODS_TEMP') && c.includes('DISALLOW_FILE_MODS\', true'))).toBe(true);
    });

    it('restores lock even if installation step throws an error', async () => {
      mockCtx.run = jest.fn(async (cmd) => {
        executedCmds.push(cmd);
        if (cmd.includes('grep -q "DISALLOW_FILE_MODS"')) {
          return { code: 0, stdout: 'LOCKED:/var/www/vhosts/ejemplo.test/httpdocs/wp-config.php\n' };
        }
        if (cmd.includes('unzip -o -q')) {
          throw new Error('Disk full error');
        }
        if (cmd.includes('RESTORED')) {
          return { code: 0, stdout: 'RESTORED' };
        }
        return { code: 0, stdout: '' };
      });

      await expect(
        runStep6(mockCtx, { elementorZipRemotePath: '/tmp/elementor.zip' })
      ).rejects.toThrow('Disk full error');

      // Se debe haber intentado restaurar el candado en el finally
      expect(executedCmds.some((c) => c.includes('KRAKEN_MODS_TEMP') && c.includes('DISALLOW_FILE_MODS\', true'))).toBe(true);
    });
  });
});

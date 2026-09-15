export interface LocalDeviceConfig {
  deviceId: string;
  deviceName: string;
  terminalNumber: number;
}

const STORAGE_DEVICE_KEY = 'pdv_device_config_v1';

export class DeviceConfigService {
  private static cachedConfig: LocalDeviceConfig | null = null;

  public static getConfig(): LocalDeviceConfig {
    if (this.cachedConfig) return this.cachedConfig;

    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(STORAGE_DEVICE_KEY);
        if (raw) {
          this.cachedConfig = JSON.parse(raw);
          return this.cachedConfig!;
        }
      } catch (err) {
        console.error('[DeviceConfig] Erro ao carregar config local:', err);
      }
    }

    // Configuração padrão para Caixa 01
    const defaultConfig: LocalDeviceConfig = {
      deviceId: 'caixa-01',
      deviceName: 'Caixa Principal',
      terminalNumber: 1,
    };
    this.cachedConfig = defaultConfig;
    return defaultConfig;
  }

  public static saveConfig(config: LocalDeviceConfig): void {
    this.cachedConfig = config;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_DEVICE_KEY, JSON.stringify(config));
      } catch (err) {
        console.error('[DeviceConfig] Erro ao salvar config local:', err);
      }
    }
  }
}

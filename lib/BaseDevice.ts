import Homey, {FlowCard} from 'homey';

import {Logger} from "./Logger";
import {SamsungConfig, SamsungConfigImpl} from "./SamsungConfig";
import {HomeyIpUtil, HomeyIpUtilImpl} from "./HomeyIpUtil";
import {SamsungClient} from "./SamsungBase";
import {UPnPClient, UPnPClientImpl} from "./UPnPClient";
import {DeviceSettings} from "./types";
import {keycodes} from './keys';

export class BaseDevice extends Homey.Device {

    private static readonly WAKE_AFTER_POWEROFF_DELAY_MS = 15000;

    logger: any;
    config!: SamsungConfig;
    homeyIpUtil!: HomeyIpUtil;
    samsungClient!: SamsungClient;
    upnpClient!: UPnPClient;
    turning_onoff_process: boolean | undefined = undefined;
    onOffPollingTimeout?: NodeJS.Timeout;
    onOffCheckTimeout?: NodeJS.Timeout;
    powerStatePollingTimeout?: NodeJS.Timeout;
    private wakeRetries: number = 0;
    private lastPowerOffAt?: number;
    private deleted?: boolean;

    async initDevice(deviceType: string) {
        // @ts-ignore
        this.logger = new Logger({
            homey: this.homey,
            logFunc: this.log,
            errorFunc: this.error,
        }, Homey.env);
        await this.initLogger(deviceType);

        // @ts-ignore
        this.config = new SamsungConfigImpl({device: this, logger: this.logger});
        this.homeyIpUtil = new HomeyIpUtilImpl();

        this.upnpClient = new UPnPClientImpl({config: this.config, logger: this.logger});
        this.upnpClient.on('available', this.onUPnPAvailable.bind(this));

        await this.updateMacAddress(this.config.getSetting(DeviceSettings.ipaddress));
    }

    async initLogger(deviceType: string) {
        this.logger.setTags({deviceType});
        const modelName = this.getSetting(DeviceSettings.modelName);
        if (modelName) {
            this.logger.setTags({modelName});
        }
    }

    async migrate() {
        try {
            const upnpAvailable = this.getStoreValue('upnp_available');
            this.logger.info(`Migration: upnp_available = ${upnpAvailable}`);
            if (upnpAvailable) {
                if (!this.hasCapability('volume_set')) {
                    await this.addCapability('volume_set');
                    this.logger.info('Migration: added volume_set');
                }
            } else {
                if (this.hasCapability('volume_set')) {
                    await this.removeCapability('volume_set');
                    this.logger.info('Migration: removed volume_set');
                }
            }
            const migVersion = this.getStoreValue('version');
            if (!!migVersion && migVersion < 2) {
                if (!this.getAvailable()) {
                    await this.setAvailable();
                }
            }
            await this.setStoreValue('version', 2);
        } catch (err) {
            this.logger.error('Migration failed', err);
        }
    }

    async registerCapListeners() {
        this.registerCapabilityListener('onoff', async (value, opts) => {
            return this.turnOnOff(value);
        });

        this.registerCapabilityListener('volume_set', async (value, opts) => {
            return this.upnpClient.setVolume(Math.round(value * this.getSetting(DeviceSettings.max_volume)));
        });

        this.registerCapabilityListener('volume_mute', async (value, opts) => {
            return this.samsungClient.sendKey('KEY_MUTE');
        });

        this.registerCapabilityListener('volume_up', async (value, opts) => {
            return this.samsungClient.sendKey('KEY_VOLUP');
        });

        this.registerCapabilityListener('volume_down', async (value, opts) => {
            return this.samsungClient.sendKey('KEY_VOLDOWN');
        });

        this.registerCapabilityListener('channel_up', async (value, opts) => {
            return this.samsungClient.sendKey('KEY_CHUP');
        });

        this.registerCapabilityListener('channel_down', async (value, opts) => {
            return this.samsungClient.sendKey('KEY_CHDOWN');
        });
    }

    onKeyAutocomplete(query: string, args: any): Promise<FlowCard.ArgumentAutocompleteResults> {
        return Promise.resolve(keycodes.filter((result: any) => {
            return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        }));
    }

    onAppAutocomplete(query: string, args: any): Promise<FlowCard.ArgumentAutocompleteResults> {
        let apps = this.samsungClient.getApps();
        return Promise.resolve((apps === undefined ? [] : apps).map((app: any) => {
            return {
                name: app.name,
                appId: app.appId,
                dialId: app.dialId
            };
        }).filter((result: any) => {
            return result.name.toLowerCase().indexOf(query.toLowerCase()) > -1;
        }).sort((a: { name: string; }, b: { name: string; }) => {
            if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
            if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
            return 0;
        }));
    }

    async setPowerState(powerState: boolean): Promise<void> {
        try {
            this.logger.info('setPowerState', powerState);
            await this.turnOnOff(powerState);
        } catch (err) {
            this.logger.info('setPowerState ERROR', err);
            throw err;
        }
    }

    async onAdded() {
        this.logger.info(`device added: ${this.getData().id}`);
        let settings = this.getSettings();
        if (settings.ipaddress) {
            await this.updateMacAddress(settings.ipaddress);
        } else {
            await this.setUnavailable(this.homey.__('errors.unavailable.ip_address_missing')).catch(err => this.logger.error(err));
        }
    }

    onDeleted() {
        this.deleted = true;
        this.clearPowerStatePolling();
        this.clearOnOffPolling();
        this.clearOnOffTimeout();
        this.logger.verbose('device deleted');
    }

    async checkIPAddress(ipaddress: string) {
        this.logger.info('checkIPAddress', ipaddress);
        const info = await this.samsungClient.pingPort(ipaddress);
        if (info) {
            this.logger.info('TV set available');
            await this.setAvailable();
        } else {
            this.logger.info('TV set unavailable');
            await this.setUnavailable(this.homey.__('errors.unavailable.not_found')).catch(err => this.logger.error(err));
        }
    }

    async updateMacAddress(ipaddress?: string) {
        try {
            if (ipaddress && ipaddress.length > 0) {
                const mac = await this.homey.arp.getMAC(ipaddress);
                if (mac.indexOf(':') >= 0) {
                    this.logger.info(`Found MAC address for IP address: ${ipaddress} -> ${mac}`);
                    await this.config.setSetting(DeviceSettings.mac_address, mac).catch((err: any) => this.logger.error(err));
                    return true;
                } else {
                    this.logger.info('Invalid MAC address for IP address', ipaddress, mac);
                }
            }
        } catch (err) {
            this.logger.info(`Unable to find MAC address for IP address: ${ipaddress}`);
        }

        try {
            const info = await this.samsungClient.getInfo(ipaddress);
            const mac = info?.device?.wifiMac;
            if (mac && mac.indexOf(':') >= 0) {
                this.logger.info(`Found MAC address from device info: ${ipaddress} -> ${mac}`);
                await this.config.setSetting(DeviceSettings.mac_address, mac).catch((err: any) => this.logger.error(err));
                return true;
            }
        } catch (err) {
            this.logger.info(`Unable to fetch MAC address from device info: ${ipaddress}`);
        }

        return false;
    }

    // Turn on / off

    async turnOnOff(onOff: any) {
        if (this.turning_onoff_process !== undefined) {
            throw new Error(this.homey.__(this.turning_onoff_process ? 'errors.onoff.on_in_progress' : 'errors.onoff.off_in_progress'));
        }

        try {
            this.scheduleOnOffPolling();
            this.scheduleOnOffTimeout();
            this.turning_onoff_process = onOff;
            if (onOff) {
                this.wakeRetries = 10;
                const elapsedSincePowerOff = this.lastPowerOffAt ? Date.now() - this.lastPowerOffAt : undefined;
                const wakeDelay = elapsedSincePowerOff === undefined ? 0 : Math.max(0, BaseDevice.WAKE_AFTER_POWEROFF_DELAY_MS - elapsedSincePowerOff);
                if (wakeDelay > 0) {
                    this.logger.info(`turnOnOff: delaying wake for ${wakeDelay} ms after power off`);
                    void this.delayedWake(wakeDelay);
                } else {
                    await this.samsungClient.wake();
                }
            } else {
                this.lastPowerOffAt = Date.now();
                await this.samsungClient.turnOff();
            }
            this.logger.info('turnOnOff: in progress: ' + (onOff ? 'on' : 'off'));
        } catch (err) {
            this.logger.info('turnOnOff: failed: ', err);
            this.clearOnOffPolling();
            this.clearOnOffTimeout();
            throw err;
        }
    }

    async delayedWake(wakeDelay: number) {
        try {
            await this._delay(wakeDelay);
            if (this.turning_onoff_process) {
                await this.samsungClient.wake();
            }
        } catch (err) {
            this.logger.info('delayedWake: failed', err);
            this.turning_onoff_process = undefined;
            this.clearOnOffPolling();
            this.clearOnOffTimeout();
        }
    }

    // On / off polling

    clearOnOffPolling() {
        if (this.onOffPollingTimeout) {
            this.homey.clearTimeout(this.onOffPollingTimeout);
            this.onOffPollingTimeout = undefined;
        }
    }

    scheduleOnOffPolling() {
        this.clearOnOffPolling();
        this.onOffPollingTimeout = this.homey.setTimeout(this.doOnOffPollDevice.bind(this), 1000);
    }

    async doOnOffPollDevice() {
        if (this.deleted) {
            return;
        }
        // Skip is not in turning on / off process ?
        if (this.turning_onoff_process === undefined) {
            return;
        }
        try {
            const onOff = await this.isDeviceOnline(500);
            if (this.turning_onoff_process === onOff) {
                // Finished on / off process
                this.turning_onoff_process = undefined;
                this.clearOnOffPolling();
                this.clearOnOffTimeout();
                this.logger.info('doOnOffPollDevice: finished');
            }
            if (this.turning_onoff_process && !onOff && this.wakeRetries > 0) {
                this.wakeRetries--;
                await this.samsungClient.wake();
            }
        } catch (err) {
            this.logger.info(err);
        } finally {
            this.scheduleOnOffPolling();
        }
    }

    // 45 seconds timeout for on / off polling

    clearOnOffTimeout() {
        if (this.onOffCheckTimeout) {
            this.homey.clearTimeout(this.onOffCheckTimeout);
            this.onOffCheckTimeout = undefined;
        }
    }

    scheduleOnOffTimeout() {
        this.clearOnOffTimeout();
        this.onOffCheckTimeout = this.homey.setTimeout(this.onOnOffTimeout.bind(this), 45000);
    }

    onOnOffTimeout() {
        this.turning_onoff_process = undefined;
        this.clearOnOffPolling();
    }

    // UPnP

    async onUPnPAvailable(event: any) {
        this.logger.info('UPnP is available');
        await this.setStoreValue('upnp_available', true);
        await this.migrate();
    }

    // Power State Polling

    clearPowerStatePolling() {
        if (this.powerStatePollingTimeout) {
            this.homey.clearTimeout(this.powerStatePollingTimeout);
            this.powerStatePollingTimeout = undefined;
        }
    }

    schedulePowerStatePolling(polling_interval?: number) {
        this.clearPowerStatePolling();
        const settings = this.getSettings();
        const pollInterval = polling_interval ?? settings.poll_interval ?? 10;
        if (pollInterval > 0) {
            this.powerStatePollingTimeout = this.homey.setTimeout(this.doPowerStatePolling.bind(this), pollInterval * 1000);
        }
    }

    async doPowerStatePolling() {
        if (this.deleted) {
            return;
        }

        try {
            // Skip if in turning on / off process ?
            if (this.turning_onoff_process !== undefined) {
                return;
            }

            const powerStatePollingDisabled = this.getSetting(DeviceSettings.power_state_polling) === false;
            const onOff = powerStatePollingDisabled ?
                this.getCapabilityValue('onoff') :
                await this.isDeviceOnline();

            if (onOff && !this.getAvailable()) {
                await this.setAvailable();
            }
            if (onOff !== undefined && onOff !== this.getCapabilityValue('onoff')) {
                await this.setCapabilityValue('onoff', onOff).catch(err => this.logger.error(err));
            }
            if (onOff) {
                this.logger.verbose('pollDevice: TV is on');
                await this.onDeviceOnline();
            }
        } catch (err) {
            this.logger.info(err);
        } finally {
            this.schedulePowerStatePolling();
        }
    }

    async isDeviceOnline(timeout?: any) {
        const pollMethods = this.pollMethods(timeout).filter(pm => !!pm);
        const pollResults = await Promise.all(pollMethods.map(pm => pm.method));
        const onOff = pollResults.includes(true) ? true : pollResults.includes(false) ? false : undefined;
        return onOff;
    }

    pollMethods(timeout: any): any[] {
        if (this.getSetting(DeviceSettings.power_state)) {
            return [
                {id: 'apiActive', method: this.samsungClient.apiActive(timeout)}
            ];
        }
        return [
            {id: 'apiActive', method: this.samsungClient.apiActive(timeout)},
            {id: 'upnp', method: this.upnpClient ? this.upnpClient.apiActive(timeout) : undefined},
            {id: 'ping', method: this.samsungClient.pingPort(undefined, undefined, timeout)}
        ];
    }

    async onDeviceOnline() {
        throw new Error('unimplemented');
    }

    async shouldFetchPowerState() {
        if (this.getSetting(DeviceSettings.power_state) === null) {
            try {
                const info = await this.samsungClient.getInfo();
                const hasPowerState = !!(info.device && info.device.PowerState);
                await this.config.setSetting(DeviceSettings.power_state, hasPowerState).catch((err: any) => this.logger.error(err));
                this.logger.info(`Has PowerState set to: ${hasPowerState}`);
            } catch (err) {
                this.logger.info('Fetching PowerState failed', err);
            }
        }
    }

    async shouldFetchModelName() {
        if (!this.getSetting(DeviceSettings.name) ||
            !this.getSetting(DeviceSettings.modelName)) {
            let name = 'notset';
            let modelName = 'unknown';
            try {
                const info = await this.samsungClient.getInfo();
                this.logger.verbose('shouldFetchModelName', info);
                if (info && info.name) {
                    name = info.name;
                }
                if (info && info.device && info.device.modelName) {
                    modelName = info.device.modelName;
                } else if (info && info.device && info.device.ModelName) {
                    modelName = info.device.ModelName;
                }
            } catch (err) {
                this.logger.info('Fetching device info failed', err);
            } finally {
                await this.config.setSetting(DeviceSettings.name, name).catch((err: any) => this.logger.error(err));
                await this.config.setSetting(DeviceSettings.modelName, modelName).catch((err: any) => this.logger.error(err));
                this.logger.setTags({modelName});
                this.logger.info(`Device settings updated. name: ${name}, modelName: ${modelName}`);
            }
        }
    }

    async fetchState() {
        try {
            if (this.upnpClient) {
                await this.upnpClient.search();
                if (this.hasCapability('volume_set')) {
                    const volumeState = await this.upnpClient.getVolume();
                    if (volumeState !== undefined) {
                        const volume = Math.round(100 * volumeState / this.getSetting(DeviceSettings.max_volume)) / 100;
                        if (volume >= 0.0 && volume <= 1.0 && volume !== this.getCapabilityValue('volume_set')) {
                            await this.setCapabilityValue('volume_set', volume).catch(err => this.logger.error('Error setting volume_set capability', err));
                            this.logger.verbose('fetchState: volume updated: ', volume);
                        }
                    }
                }
                if (this.hasCapability('volume_mute')) {
                    const muted = await this.upnpClient.getMute();
                    if (muted !== undefined) {
                        if (muted !== this.getCapabilityValue('volume_mute')) {
                            await this.setCapabilityValue('volume_mute', muted).catch(err => this.logger.error('Error setting volume_mute capability', err));
                            this.logger.verbose('fetchState: mute updated: ', muted);
                        }
                    }
                }
            }
        } catch (err) {
            this.logger.info('fetchState ERROR', err);
        }
    }

    _delay(ms: number) {
        return new Promise(resolve => {
            this.homey.setTimeout(resolve, ms);
        });
    }

}

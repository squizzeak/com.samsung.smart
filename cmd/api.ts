import {SamsungConfig, SamsungConfigImpl} from "../lib/SamsungConfig";
import {Logger} from "../lib/Logger";
import {SamsungClient} from "../lib/SamsungBase";
import {HomeyIpUtilImpl} from "../lib/HomeyIpUtil";
import {UPnPClientImpl} from "../lib/UPnPClient";
import {SamsungClientImpl} from "../drivers/Samsung/SamsungClient";

import {settings} from "./index";
import {DeviceSettings, HomeyDevice} from "../lib/types";
import {SmartThingsClient, SmartThingsClientImpl} from "../lib/SmartThings";
import {HomeyDeviceMock} from "./HomeyDevice";

let device: HomeyDevice;
let config: SamsungConfig;
let samsungClient: SamsungClient;
let smartThingsClient: SmartThingsClient;

export const getDevice = (): HomeyDevice => {
    return device;
}

export const getConfig = (): SamsungConfig => {
    return config;
}

export const getClient = async () => {
    return await settings.get("client") || "Samsung";
};

export const setClient = async (client: string) => {
    await settings.set("client", client);
    await initialize(client);
};

export const getSetting = async (key: DeviceSettings) => {
    const client = await getClient();
    return await settings.get(`${client}-${key}`);
}

export const setSetting = async (key: DeviceSettings, value: any) => {
    const client = await getClient();
    const val = typeof value === 'object' ? JSON.stringify(value) : value;
    await settings.set(`${client}-${key}`, val);
}

export const initSamsungClient = async () => {
    // @ts-ignore
    let logger = new Logger({
        logFunc: console.log,
        errorFunc: console.error,
    }, {});

    config = new SamsungConfigImpl({logger});
    let homeyIpUtil = new HomeyIpUtilImpl();

    let upnpClient = new UPnPClientImpl({config, logger});
    upnpClient.on('available', (event: any) => {
        console.log(event);
    });

    samsungClient = new SamsungClientImpl({
        config,
        port: 8001,
        connectionTimeout: 10,
        homeyIpUtil,
        logger
    });
    getConfig().setSetting(DeviceSettings.ipaddress, await getSetting(DeviceSettings.ipaddress));
    getConfig().setSetting(DeviceSettings.tokenAuthSupport, await getSetting(DeviceSettings.tokenAuthSupport));
    getConfig().setSetting(DeviceSettings.token, await getSetting(DeviceSettings.token));

    return samsungClient;
}

export const initSmartThingsClient = async () => {
    let logger = new Logger({
        logLevel: 3,
        logFunc: console.log,
        errorFunc: console.error,
    }, {});

    let device = new HomeyDeviceMock({logger});
    if (!config) {
        config = new SamsungConfigImpl({logger});
    }

    getConfig().setSetting(DeviceSettings.smartthings, true);

    smartThingsClient = new SmartThingsClientImpl({
        // @ts-ignore
        device,
        config,
        logger,
    });

    return smartThingsClient;
}

const initialize = async (toClient?: string) => {
    try {
        const client = toClient ? toClient : await getClient();
        if (client) {
            if (toClient) {
                //Log(colors.green(`✓ Initialized: ${toClient}`));
            }
        }
    } catch (err) {
        console.log("initialize failed:", err);
    }
};

initialize();

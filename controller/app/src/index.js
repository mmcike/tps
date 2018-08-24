const config = require("./config");

const debug = require("debug")("APP");
const multicast = require("./multicast");

const pTimeout = require('p-timeout');
const delay = ms => new Promise(res => setTimeout(res, ms))
const sstream = require('./sstream.js');
const eol = require('eol');

const app = require("./app.js");
const status = require('./status.js');
const switches = require('./switches.js');
const cameras = require('./cameras.js');
const scans = require('./scans.js');
const calibrations = require('./calibrations.js');

const liveCameras = {};

const sendCmd = async (args) => {

    const message = Buffer.concat(
        [].concat(args).map(
            arg => Buffer.isBuffer(arg) ? arg : Buffer.from([arg])
        )
    );

    await multicast.send(message, 0, message.length, config.MCAST_CAMERA_COMMAND_PORT, config.MCAST_GROUP_ADDR);
};

const all = Buffer.from('FF:FF:FF:FF:FF:FF');

const bufferFromInt32LE = int32 => { let buf = Buffer.alloc(4); buf.writeInt32LE(int32, 0); return buf; }

// TODO: Build the structures with https://github.com/TooTallNate/ref-struct
const send = {
     ping: async (mac)     => sendCmd([ Buffer.from(mac), 0 ]),
    shoot: async (mac, id) => sendCmd([ Buffer.from(mac), 1, bufferFromInt32LE(id), await config.pack() ]),
    erase: async (mac, id) => sendCmd([ Buffer.from(mac), 2, bufferFromInt32LE(id) ]),
     exec: async (mac, s)  => sendCmd([ Buffer.from(mac), 3, Buffer.from(s), 0 ]),

     pingAll: async ()   => send. ping( all     ),
    shootAll: async (id) => send.shoot( all, id ),
    eraseAll: async (id) => send.erase( all, id ),
     execAll: async (s)  => send. exec( all, s  )
};

const shotsConfig = [
    { name: 'projection', index: '1' },
    { name: 'normal',     index: '2' }
];

const request = require('request');
const eventToPromise = require('event-to-promise');
const fs = require('fs-extra');
const path = require('path');

const defer = () => { let resolve, reject, promise = new Promise((_resolve, _reject) => { resolve=_resolve; reject=_reject; }); return { resolve, reject, promise }; };

const configRecordDefer = defer();

let configRecord;
//FIXME: await for default config record on new scanner
config.service.watch().get('0').subscribe(config => { configRecordDefer.resolve(config); configRecord = config; });

const cameraIndex = mac => {
    const index = configRecord?.scanner?.map?.indexOf(mac);

    return index!=undefined && index>=0 ? index : undefined;
}

app.post("/api/shoot/preview", async (browser_request, browser_response) => {
    try {
        await status.service.patch(0, { shooting: true });
        await send.shootAll(0);
        await delay(5*1000);
        await status.service.patch(0, { shooting: false });
        browser_response.status(204).end();
    } catch(error) {
        browser_response.status(500).send(error);
    }
});

app.post("/api/shoot/scan", async (browser_request, browser_response) => {

    let scanId;

    try {
        const scan = await scans.service.create({});
        scanId = scan[scans.service.id];
        browser_response.send({ id: scanId });
        debug(`Start scan ${scanId}`);
    } catch(error) {
        browser_response.status(500).send(error);
        return;
    }

    try {
        await status.service.patch(0, { shooting: true });
        await send.shootAll(scanId);
        await delay(2*1000);
        await status.service.patch(0, { shooting: false });
    } catch(error) {
        debug(`Error Scan:${scanId}`, error);
    }
});

app.post("/scan/:scan/download", async (browser_request, browser_response) => {

    const scanId = browser_request.scan[scans.service.id];

    debug(`Downloading scan ${scanId}`);

    try {
        browser_response.status(204).end();

        await status.service.patch(0, { downloading: true });

        await Promise.all(shotsConfig.map( ({ name }) =>
            fs.ensureDir(path.join(config.PATH,`db/${scanId}/${name}/`))
        ));

        await Promise.all( configRecord.scanner.map.map( async (mac, index) => {
            try {
                if(!mac)
                    return;

                const camera = liveCameras[mac];

                if(!camera || !camera.online) {
                    await scans.fail(scanId, index);
                    return;
                }

                await Promise.all(shotsConfig.map( async ({ name, index: cameraFileIndex }) => {

                    // Use HEAD request to check if the target jpg file exists

                    const fileName = `/db/${scanId}/${name}/${index}.jpg`;

                    const file_stream = fs.createWriteStream(path.join(config.PATH, fileName));
                    const camera_request = request.get(`http://${camera.address}/${scanId}-${cameraFileIndex}.jpg`);

                    camera_request.pause();

                    try {

                        const [response] = await eventToPromise.multi(camera_request, ["response"], ["error", "abort"] );

                        if(response.statusCode!=200) {
                            debug(`Response ${response.statusCode} from ${response.url}`);

                            camera_request.destroy();
                            file_stream.destroy();

                            await scans.fail(scanId, index);

                            return;
                        }

                        camera_request.pipe(file_stream);
                        camera_request.resume();

                        await pTimeout(Promise.all([
                            eventToPromise.multi(camera_request, ["finish", "close", "end", "complete"], ["error", "abort"] ),
                            eventToPromise.multi(file_stream,    ["finish", "close"], ["error", "unpipe"] )
                        ]), 120*1000, `Timeout downloading ${fileName}`);

                    } catch(error) {
                        debug(`Error Scan:${scanId} Camera:${index}`, error);
                        camera_request.destroy();
                        file_stream.destroy();

                        await scans.fail(scanId, index);
                    }
                }));

                await send.erase(mac, scanId);
            } catch(error) {
                debug(`Error Scan:${scanId} Camera:${index}`, error);
            }
        }));

        debug(`Done scan ${scanId}`);

        await status.service.patch(0, { downloading: false });
        await scans.service.patch(scanId, { done: Date.now() });

    } catch(error) {
        debug(`Error Scan:${scanId}`, error);
    }
});

app.post("/api/shoot/calibration", async (browser_request, browser_response) => {

    let calibrationId;

    try {
        const calibration = await calibrations.service.create({});
        calibrationId = calibration[calibrations.service.id];
        browser_response.send({ id: calibrationId });
        debug(`Start calibration ${calibrationId}`);
    } catch(error) {
        browser_response.status(500).send(error);
        return;
    }

    try {
        await status.service.patch(0, { shooting: true });
        await send.shootAll(calibrationId);
        await delay(5*1000);
        await status.service.patch(0, { shooting: false });

        await status.service.patch(0, { downloading: true });

        await fs.ensureDir(path.join(config.PATH,`db/${calibrationId}/calibration/`));

        await Promise.all( configRecord.scanner.map.map( async (mac, index) => {
            try {
                if(!mac)
                    return;

                const camera = liveCameras[mac];

                if(!camera || !camera.online) {
                    await calibrations.fail(calibrationId, index);
                    return;
                }

                // Use HEAD request to check if the target jpg file exists

                const fileName = `/db/${calibrationId}/calibration/${index}.jpg`;

                const file_stream = fs.createWriteStream(path.join(config.PATH, fileName));
                const camera_request = request.get(`http://${camera.address}/${calibrationId}-2.jpg`);

                camera_request.pause();

                try {
                    const [response] = await eventToPromise.multi(camera_request, ["response"], ["error", "abort"] );

                    if(response.statusCode!=200) {
                        debug(`Response ${response.statusCode} from ${response.url}`);

                        camera_request.destroy();
                        file_stream.destroy();

                        await calibrations.fail(calibrationId, index);

                        return;
                    }

                    camera_request.pipe(file_stream);
                    camera_request.resume();

                    await pTimeout(Promise.all([
                        eventToPromise.multi(camera_request, ["finish", "close", "end", "complete"], ["error", "abort"] ),
                        eventToPromise.multi(file_stream,    ["finish", "close"], ["error", "unpipe"] )
                    ]), 120*1000, `Timeout downloading ${fileName}`);

                } catch(error) {
                    debug(`Error Calibration:${calibrationId} Camera:${index}`, error);
                    camera_request.destroy();
                    file_stream.destroy();

                    await calibrations.fail(calibrationId, index);
                }

                await send.erase(mac, calibrationId);
            } catch(error) {
                debug(`Error Calibration:${calibrationId} Camera:${index}`, error);
            }
        }));

        debug(`Done calibration ${calibrationId}`);

        await status.service.patch(0, { downloading: false });
        await calibrations.service.patch(calibrationId, { done: Date.now() });

    } catch(error) {
        debug(`Error Calibration:${calibrationId}`, error);
    }
});

const powerCycleAllPorts = async switchConfig =>
    tplinks[switchConfig.address].session(switchConfig.address, async device => {

        try {
            let tasks = [];

            for(let port=0; port < switchConfig.ports; port++) {
                debug(`Forced power cycle ${switchConfig.address}:${port}`);
                tasks.push(device.powerCycle(port, 4000));
            }

            await Promise.all(tasks);
        } catch(error) {
            debug(`Power cycle ${switchConfig.address}`, error);
        }
    });

app.post("/api/cameras/restart", async (browser_request, browser_response) => {
    try {
        let tasks = [];

        await status.service.patch(0, { restarting: true });

        for(let switch0 of config.SWITCHES) {

            tasks.push(powerCycleAllPorts(switch0));

            for(let switch1 of switch0.switches) {
                tasks.push(powerCycleAllPorts(switch1));
            }
        }

        await Promise.all(tasks);

        lastReboot = Date.now();

        await status.service.patch(0, { restarting: false });

        browser_response.status(204).end();

    } catch(error) {
        await status.service.patch(0, { restarting: false });
        browser_response.status(500).send(error);
    }
});

const download = async (mac, file) =>
    pTimeout(retry(5, async () => new Promise( (resolve,reject) => {
        const req = request(`http://${liveCameras[mac].address}/${file}`, (error, response, body) => {
            if(error) { req.abort(); reject(error); }
            if(response?.statusCode!=200) { req.abort(); resolve(undefined); }
            resolve(body); req.end();
        });
    })), 10*1000, `Timeout downloading ${mac} ${file}`);

const checkNetboot = async (mac) => {
    await send.exec(mac, "vcgencmd otp_dump > /var/www/otp_dump");
    await delay(100);

    const otp_dump = await download(mac, "otp_dump");
    const otp = eol.split(otp_dump).map(line => line.split(':')).reduce( (otp, [addr, value]) => Object.assign(otp, typeof(value)!="undefined" && { [parseInt(addr)]:parseInt(value,16) }), []);

    if(otp[17]!=0x3020000a) {
        debug(`Configuring netboot on ${mac} - ${otp[17]?.toString(16)}`);
        await send.exec(mac, `mkdir /var/fat;mount /dev/mmcblk0p1 /var/fat;echo "program_usb_boot_mode=1" >> /var/fat/config.txt;sync;sync;sync;reboot;`);
    }
}

const cameraState= async (mac) => {
    await send.exec(mac, "cp /etc/*-version /var/www/");
    await delay(100);

    const    cameraVersion = await download(mac,    "camera-version");
    const buildrootVersion = await download(mac, "buildroot-version");

    const needsUpgrade = cameraVersion?.trim()!=CAMERAFIRMWARESHA1 || buildrootVersion?.trim()!=BUILDROOTSHA1;

    await send.exec(mac, "ls /dev/ > /var/www/dev");
    await delay(100);
    const dev = await download(mac, "dev");
    const hasSDcard = dev.includes("mmcblk0");

    await send.exec(mac, "cp /proc/cmdline /var/www/");
    await delay(100);
    const cmdline = await download(mac, "cmdline");
    const bootFromSDcard = cmdline.includes("root=/dev/mmcblk0");

    return { cameraVersion, buildrootVersion, dev, cmdline, needsUpgrade, hasSDcard, bootFromSDcard };
}

const upgradeCameraFirmmware = async (mac) => {

    const unlock = await upgradeMutex.lock();

    try {
        const camera = await cameraState(mac);

        if(!camera.needsUpgrade && (!camera.hasSDcard || camera.bootFromSDcard)) {
            debug(`Camera ${mac} is uptodate`);
            unlock();
            return;
        }

        // TODO: add the camera to the upgrade list

        if(!camera.hasSDcard && camera.needsUpgrade) {
            await send.exec(mac, "reboot");
        } else if(camera.hasSDcard && (!camera.bootFromSDcard || camera.needsUpgrade)) {
            debug(`Upgrading camera ${mac} from version ${camera.cameraVersion||"unknown"} to ${CAMERAFIRMWARESHA1}`);
            const cmd =  `"tftp -g -l /tmp/sdcard.img -r sdcard.img ${addressEnd(liveCameras[mac].address,200)} && dd if=/tmp/sdcard.img of=/dev/mmcblk0 && sync; reboot;"`;
            await send.exec(mac, `echo ${cmd} > /var/www/upgrade.sh`);
            await send.exec(mac, "chmod +x /var/www/upgrade.sh");
            await send.exec(mac, "/var/www/upgrade.sh");
        } else {
            debug(`Camera ${mac} needsUpgrade=${camera.needsUpgrade} hasSDcard=${camera.hasSDcard} bootFromSDcard=${camera.bootFromSDcard}`);
            unlock();
            return;
        }

        let afterReboot;
        do {
            await delay(5*1000);
            // TODO: Timout the loop
            try {
                afterReboot = await cameraState(mac);
                debug(`Camera ${mac} needsUpgrade=${afterReboot.needsUpgrade} hasSDcard=${afterReboot.hasSDcard} bootFromSDcard=${afterReboot.bootFromSDcard}`);
            } catch(error) {
                debug("Upgrade polling error", error);
            }
        } while(afterReboot.needsUpgrade || (afterReboot.hasSDcard && !afterReboot.bootFromSDcard));

        // TODO: remove the camera from the upgrade list
        unlock();

    } catch(error) {
        debug("Camera upgrade error", error);
        unlock();
    }
}

let linking = false;

const mutex = require("await-mutex").default;
const newCameraMutex = new mutex();
const upgradeMutex = new mutex();

const eraseNewCameras = async () => {

    let unlock = await newCameraMutex.lock();

    try {
        let { scanner } = configRecord;

        scanner = scanner || {};
        scanner.new = [];

        await config.service.patch('0', { scanner } );

        unlock();
    } catch(error) {
        unlock();
        throw error;
    }
}

const onMessage = async (message, rinfo) => {
    if(message.length==18) {
        const address = rinfo.address;
        const mac = message.toString("ascii", 0, 17);

        if(!liveCameras[mac]) {
            try {
                debug(`Found new ${mac} ${address}`);
                await cameras.service.create({ id: mac, address, mac, online:true });
                liveCameras[mac] = { address, online:true, lastSeen: Date.now() };

                let unlock = await newCameraMutex.lock();

                try {
                    let { scanner } = configRecord;

                    scanner = scanner || {};
                    scanner.map = scanner.map || [];
                    scanner.new = scanner.new || [];

                    if(!scanner.map.includes(mac) && !scanner.new.includes(mac)) {
                        scanner.new.push(mac);
                        await config.service.patch('0', { scanner } );
                    }
                    unlock();
                } catch(error) {
                    unlock();
                    throw error;
                }

                await checkNetboot(mac);
                await upgradeCameraFirmmware(mac);

            } catch(error) {
                debug("onMessage new:", error);
            }
        } else if(liveCameras[mac].address != address || !liveCameras[mac].online) {
            try {
                debug(`Recovering ${liveCameras[mac].switchAddress}:${liveCameras[mac].port} ${address}`);
                await cameras.service.patch(mac, { address, online: true });
                liveCameras[mac] = { ...liveCameras[mac], address, online: true };

                await checkNetboot(mac);
                await upgradeCameraFirmmware(mac);

            } catch(error) {
                debug("onMessage update:", error);
            }
        }

        liveCameras[mac].lastSeen = Date.now();
    } else if(message.length==500) {
        const camera = Object.values(liveCameras).find( c => c.address==rinfo.address );
        // TODO: Log message to external file on the SSD
        debug(`CAMERA ${camera?.switchAddress}:${camera?.port} ERROR:`, message.toString("ascii", 0, 500));
    } else {
        debug("Received:", message.length, message);
    }
};

const linkSwitch = async switchConfig =>
    await tplinks[switchConfig.address].session(switchConfig.address, async device => {

        try {
            const table = await device.portMacTable();

            for(let { port, mac } of table) {
                if(liveCameras[mac] && port<switchConfig.ports && port!=switchConfig.uplinkPort) {
                    if( liveCameras[mac].switchAddress != switchConfig.address ||
                        liveCameras[mac].port          != port                 ||
                        liveCameras[mac].index         != cameraIndex(mac)) {

                        liveCameras[mac] = {
                            ...liveCameras[mac],
                            switchAddress:switchConfig.address,
                            port,
                            index:cameraIndex(mac)
                        };

                        await cameras.service.patch(mac, {
                            switchAddress:switchConfig.address,
                            port,
                            index: liveCameras[mac].index
                        });

                        debug(`Linking ${switchConfig.address}:${port} to ${liveCameras[mac].address}`);
                    }
                }
            }
        } catch(error) {
            debug(`linkSwitch ${switchConfig.address}:`, error);
        }
    });

const link = async () => {
    try {
        let tasks = [];

        // Get MAC addresses from the switches
        for(let switch0 of config.SWITCHES) {

            if(switch0.switches.length==0)
                tasks.push(linkSwitch(switch0));

            for(let switch1 of switch0.switches) {

                tasks.push(linkSwitch(switch1));
            }
        }

        await Promise.all(tasks);
    } catch(error) {
        debug("link:", error);
    }
}

const discover = async () => {

    try {
        await send.pingAll();

        if(!linking) {
            linking = true;

            try { await link() } catch(error) { debug("Link:", error); }

            linking = false;
        }
    } catch(error) {
        debug("discover:", error);
    }
}

const interfaces = require('./interfaces.js');

const ip = require("ip");
const time = require("time-since");
const Bottleneck = require("bottleneck");

const bootLimiter = new Bottleneck({ maxConcurrent: 10 });
//bootLimiter.on('debug', (msg, data) => debug("BOTTLENECK:", msg, data));

const powerCycle = async (address, port) => {
    try {
        debug(`Power cycle ${address}:${port}`);
        await tplinks[address].session( address, device => device.powerDisable(port) );
        await delay(  3*1000 );
        await tplinks[address].session( address, device => device.powerEnable(port) );
        await delay( 30*1000 );
    } catch(error) {
        debug(`Power cycle ${address}:${port}`, error);
    }
}

let tplinks = {};

const tplinksPrepare = () => {
    for(let switch0 of config.SWITCHES) {

        tplinks[switch0.address] = require("./tplink")();

        for(let switch1 of switch0.switches)
            tplinks[switch1.address] = require("./tplink")();
    }
};

tplinksPrepare();

const addressEnd = (address, end) => ip.toString( [...ip.toBuffer(address).slice(0, 3), end] );

let probeSwitch0 = async (switch0, address)  => {
    try {
        debug(`Checking switch0 ${address}`);

        await interfaces.upOnly(switch0.interface, addressEnd(address, 200));
        return await tplinks[switch0.address].probe(address, config.SWITCH_PROBE_TIMEOUTS);
    } catch(error) {
        debug(`Checking switch0 ${address}`, error);
        return false;
    }
}

let probeSwitch1 = async (switch0, switch1, address) => {
    try {
        debug(`Checking switch1 ${address}`);

        await interfaces.upOnly(switch0.interface, addressEnd(switch0.address, 200));
        await tplinks[switch0.address].session(switch0.address, device => device.enableOnly( [switch1.hostPort, switch0.uplinkPort], switch0.ports ));

        await interfaces.upOnly(switch0.interface, addressEnd(address, 200));
        return await tplinks[switch1.address].probe(address, config.SWITCH_PROBE_TIMEOUTS);
    } catch(error) {
        debug(`Checking switch1 ${address}`);
        return false;
    }
}

let configure = async (netInterface, switchConfig, defaultAddress) => {

    debug(`Starting session to configure switch at ${switchConfig.address}`);

    await retry(5, async () => {
        await interfaces.upOnly(netInterface, addressEnd( defaultAddress, 200 ));
        await tplinks[switchConfig.address].session(defaultAddress, async device => {
            debug(`Configuring switch ${switchConfig.address}`);

            // First get rid of logging messages that mess with the CLI commands execution
            await device.config("no logging monitor|no logging buffer");

            debug("Monitor disabled");

            if(config.SWITCH_CONFIG_SPANNING_TREE) {
                debug("Configuring spanning tree");

                await device.config("spanning-tree|spanning-tree mode rstp");

                for(let port=0; port<switchConfig.ports; port++)
                    await device.port(port, "spanning-tree|spanning-tree common-config portfast enable");

                debug("Spanning tree configured");
            }

            if(config.SWITCH_CONFIG_PoE) {
                debug("Configuring PoE");

                for(let port=0; port<switchConfig.ports; port++)
                    await device.powerDisable(port);

                debug("PoE configured");
            }

            debug("Configure port speed");

            for(let port=0; port<switchConfig.ports; port++)
                await device.port(port, `speed ${(port==switchConfig.uplinkPort&&"1000")||switchConfig.speed||"auto"}`);

            debug("Port speed configured");

        }, config.SWITCH_CONFIG_TIMEOUTS);

        debug(`Changing IP address to ${switchConfig.address}`);
        await tplinks[switchConfig.address].changeIpAddress(defaultAddress, 0, switchConfig.address, "255.255.255.0");
        debug("IP address changed");

        await interfaces.upOnly(netInterface, addressEnd( switchConfig.address, 200 ));
        await tplinks[switchConfig.address].session(switchConfig.address, async device => {
            debug("Updating startup config");
            await device.privileged("copy running-config startup-config");
            debug("Startup config updated");
        });
    });

    debug("Switch configured");
}

let lastReboot;

const powerCycleSwitch = async switchConfig => {
    try {
        var tasks = [];

        for(let port=0; port < switchConfig.ports; port++) {
            if(!Object.values(liveCameras).find(camera => camera.switchAddress==switchConfig.address && camera.port==port) &&
                port!=switchConfig.uplinkPort) {
                tasks.push(bootLimiter.schedule(async () => await powerCycle( switchConfig.address, port )));
            }
        }

        await Promise.all(tasks);
    } catch(error) {
        debug(`powerCycleSwitch ${switchConfig.address}`, error);
    }
}

let loop = async () => {

    let tasks = [];

    for(let mac in liveCameras) {

        let camera = liveCameras[mac];

        // FIXME: Rewrite the camera discovery process
        let notSeen     = !camera.lastSeen   || time.since(camera.lastSeen  ).secs()>10*60;
        let notRebooted = !camera.lastReboot || time.since(camera.lastReboot).secs()>60;

        if(camera.online && notSeen) {

            debug(`Lost connection to ${camera.switchAddress}:${camera.port} ${camera.address}`);

            camera.online = false;

            tasks.push(await cameras.service.patch(mac, { online: false }) );
        }

        if(notSeen && notRebooted) {

            if(camera.switchAddress && camera.port)
                tasks.push(bootLimiter.schedule( async () => {
                    await powerCycle(camera.switchAddress, camera.port );
                    camera.lastReboot = Date.now();
                }));
        }
    }

    await Promise.all(tasks);

    if(!lastReboot || time.since(lastReboot).secs()>60) {

        await status.service.patch(0, { restarting: true });

        let tasks = [];

        for(let switch0 of config.SWITCHES) {
            if(switch0.switches.length==0)
                tasks.push(powerCycleSwitch(switch0));

            for(let switch1 of switch0.switches ) {
                tasks.push(powerCycleSwitch(switch1));
            }
        }

        await Promise.all(tasks);

        lastReboot = Date.now();

        await status.service.patch(0, { restarting: false });
    } else if(!tasks.length) {
        await delay(1000);
    }
}

let retry = async (maxRetries, callback) => {

    let lastError = undefined;

    for(let retries=0; retries<maxRetries; retries++) {
        try {
            return await callback();
        } catch(error) {
            lastError = error;
        }
    }

    throw lastError;
};

const probeAndConfigureSwitch0 = async switch0 => {

    if(!await probeSwitch0(switch0, switch0.address)) {

        if(!await probeSwitch0(switch0, config.SWITCH_DEFAULT_ADDRESS))
            throw `Can't connect to switch ${switch0.address}`;

        await configure(switch0.interface, switch0, config.SWITCH_DEFAULT_ADDRESS);
    }

    debug(`Found switch ${switch0.address}`);
}

const probeAndConfigureSwitch1 = async (switch0, switch1) => {

    if(!await probeSwitch1(switch0, switch1, switch1.address)) {

        if(!await probeSwitch1(switch0, switch1, config.SWITCH_DEFAULT_ADDRESS))
            throw `Can't connect to switch ${switch1.address}`;

        await interfaces.upOnly(switch0.interface, addressEnd( switch0.address, 200 ));
        await tplinks[switch0.address].session(switch0.address, device => device.enableOnly([switch1.hostPort, switch0.uplinkPort], switch0.ports));

        await configure(switch0.interface, switch1, config.SWITCH_DEFAULT_ADDRESS);
    }

    debug(`Found switch ${switch1.address}`);
}

const enableAllInterfaces = async () => {
    debug("Enable all network interfaces");

    await Promise.all(config.SWITCHES.map(
        async switch0 => {
            await interfaces.up(switch0.interface, addressEnd( switch0.address, 200 ));
            await tplinks[switch0.address].session(switch0.address, device => device.enableAll([], switch0.ports));
        }
    ));

    debug("Network interfaces are enabled");
};

let configureAllSwitches = async () => {

    debug("Configuring all switches");

    for(let switch0 of config.SWITCHES) {
        await probeAndConfigureSwitch0(switch0);

        for(let switch1 of switch0.switches) {
            await probeAndConfigureSwitch1(switch0, switch1);
        }
    }

    await enableAllInterfaces();
};

let run = async () => {

    let discoverInterval;

    await configRecordDefer.promise;

    try {
        debug("Configure all network interfaces");
        // Prepare network interfaces
        await Promise.all(config.SWITCHES.map(
            async ({ interface:netInterface, address }) => {
                await interfaces.add(netInterface, addressEnd( address, 200));
                await interfaces.up(netInterface);
            }
        ));

        // Probe and configure all switches
        debug("Detecting switches.");

        for(;;) {
            try {
                for(let switch0 of config.SWITCHES) {
                    if(!await tplinks[switch0.address].probe(switch0.address)) {
                        debug(`Can't find switch ${switch0.address}`);
                        await configureAllSwitches();
                        break;
                    } else {
                        for(let switch1 of switch0.switches )
                            if(!await tplinks[switch1.address].probe(switch1.address)) {
                                debug(`Can\'t find switch ${switch1.address}`);
                                await configureAllSwitches();
                                break;
                            }
                    }
                }

                break;
            } catch(error) {
                debug("Retrying switch detection on:", error);
                continue;
            }
        }

        debug("UDP binding");

        for(let { address } of config.SWITCHES)
            await multicast.server(config.MCAST_CAMERA_COMMAND_PORT, addressEnd( address, 200 ) );

        debug("UDP server binded");

        await multicast.client(config.MCAST_CAMERA_REPLY_PORT, config.MCAST_GROUP_ADDR);

        debug("UDP client binded");

        multicast.on("message", onMessage);

        debug("Rediscover existing non-alocated cameras");

        await eraseNewCameras();

        debug("Starting camera heartbeat");

        discoverInterval = setInterval(discover, 1000);

        /* Give some time to the get ping response from the working cameras */
        await delay(15000);

        debug("Starting main loop");

        await status.service.patch(0, { operational: true });

        while(true)
            await loop();

    } catch(error) {
        debug("Error:", error);
    }
    debug("Quitting");

    clearInterval(discoverInterval);

    server.close();

    process.abort();
}

process.on('unhandledRejection', (reason, promise) => {
    debug('Unhandled rejection at Promise:', promise, 'Reason:', reason);
});

debug("Starting");

/* app.listen() *MUST* be called after all feathers plugins are initialised
 *  * (especialy the authentication ones) to call their setup() methods. */

const server = app.listen(80);

run();
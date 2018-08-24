const app = require('./app.js');
const nedb = require('nedb');
const feathersNedb = require('feathers-nedb');
const path = require('path');
const debug = require('debug')('APP:config');

const settings = {
    PATH: "/disk/sda1",
    SWITCH_DEFAULT_ADDRESS: "192.168.0.1",
    MCAST_GROUP_ADDR: "224.1.1.1",
    MCAST_CAMERA_COMMAND_PORT: 6502,
    MCAST_CAMERA_REPLY_PORT: 6501,
    SWITCH_PROBE_TIMEOUTS: {
        timeout: 1*10*1000,
        execTimeout: 1*10*1000
    },
    SWITCH_CONFIG_TIMEOUTS: {
        timeout: 2*60*1000,
        execTimeout: 2*60*1000
    },
    SWITCH_CONFIG_SPANNING_TREE: false,
    SWITCH_CONFIG_PoE: false,
    SWITCHES: [
        {
            interface: "p1p1",
            address: "192.168.201.199",
            ports: 48,
            uplinkPort: 47,
            speed: 100,
            switches: [
            ]
        }, {
            interface: "p12p1",
            address: "192.168.202.199",
            ports: 48,
            uplinkPort: 47,
            speed: 100,
            switches: [
            ]
        }, {
            interface: "p13p1",
            address: "192.168.203.199",
            ports: 48,
            uplinkPort: 47,
            speed: 100,
            switches: [
            ]
        }
    ],
    CAMERA: {
        quality:         75, //    1 .. 100
        sharpness:        0, // -100 .. 100
        contrast:         0, // -100 .. 100
        brightness:      50, //    0 .. 100
        saturation:       0, // -100 .. 100
        shutterSpeed: 16000, //    1 ..
        iso:            100, //  100 .. 800
        redGain:       1000, //    0 ..
        blueGain:      1000, //    0 ..
        drc:              0, //    0 ..   3 OFF, LOW, MEDIUM, HIGH
        whiteBalance:     1, //    0 ..   8 OFF, AUTO ... HORIZON
        gpioDelay17:      0,
        gpioDelay18:      0,
        gpioDelay22:      0,
        gpioDelay27:      0,
        open:          true,
        close:         true,
    }
};

const defaultConfig = {
    _id: '0',
    preview: 1,
    nextId: 1,
    scanFields: 'First Name;Last Name;Email;Gender:Male,Female,Other',
    camera: {
        normal: settings.CAMERA,
        projection: settings.CAMERA
    },
    scanner: {
        columns: 18,
        rows: 7,
        extra: 3,
        map: [],
        new: []
    }
};

const initDefault = async error => {

    if(error)
        debug("Configuration autoload error:", error);

    try {
        const configs = await service.find();

        if(configs.length==0)
            await service.create(defaultConfig);
    } catch(error) {
        debug("initDefault:", error);
        await service.create(defaultConfig);
    }
};

const db = new nedb({
    filename: path.join(settings.PATH,'config.json'),
    autoload: true,
    onload: initDefault
});

app.use('/api/config', feathersNedb({ Model: db }));

const service = app.service('/api/config');

const _pack = config => {

    const message = Buffer.alloc(25);

    let offset = 0;

    // Keep in sync with 'struct camera_configuration'

    offset = message.writeInt16LE(config.shutterSpeed, offset);
    offset = message.writeInt16LE(config.iso,          offset);
    offset = message.writeInt16LE(config.redGain,      offset);
    offset = message.writeInt16LE(config.blueGain,     offset);
    offset = message.writeInt16LE(config.gpioDelay17,  offset);
    offset = message.writeInt16LE(config.gpioDelay18,  offset);
    offset = message.writeInt16LE(config.gpioDelay22,  offset);
    offset = message.writeInt16LE(config.gpioDelay27,  offset);
    offset = message.writeInt8   (config.open,         offset);
    offset = message.writeInt8   (config.close,        offset);
    offset = message.writeInt8   (config.quality,      offset);
    offset = message.writeInt8   (config.sharpness,    offset);
    offset = message.writeInt8   (config.contrast,     offset);
    offset = message.writeInt8   (config.brightness,   offset);
    offset = message.writeInt8   (config.saturation,   offset);
    offset = message.writeInt8   (config.drc,          offset);
    offset = message.writeInt8   (config.whiteBalance, offset);

    return message;
}

const pack = async () => {

    const { camera: { normal, projection }  } = await service.get('0');

    return Buffer.concat([_pack(projection), _pack(normal)]);
};

const cleanCameraMap = async context => {
    const oldRecord = await service.get(context.id);

    if(oldRecord.scanner && context.data.scanner) {
        if((context.data.scanner.columns!=undefined && (context.data.scanner.columns != oldRecord.scanner.columns)) ||
           (context.data.scanner.rows   !=undefined && (context.data.scanner.rows    != oldRecord.scanner.rows   )) ||
           (context.data.scanner.extra  !=undefined && (context.data.scanner.extra   != oldRecord.scanner.extra  ))) {

            context.data.scanner.new = [].concat(context.data.scanner.new || oldRecord.scanner.new, context.data.scanner.map || oldRecord.scanner.map).filter(mac=>!!mac);
            context.data.scanner.map = [];
        }
    }

    return context;
};

service.hooks({
    before: {
        update: cleanCameraMap,
        patch: cleanCameraMap
    }
});

module.exports = { ...settings, service, pack };

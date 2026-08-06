// based on https://github.com/ArduPilot/ardupilot/blob/master/Tools/scripts/decode_devid.py

export enum BUS_TYPE {
  I2C = 1,
  SPI = 2,
  UAVCAN = 3,
  SITL = 4,
  MSP = 5,
  SERIAL = 6,
  QSPI = 7,
}

enum COMPASS_TYPE {
  UNKNOWN = 0x00,
  HMC5883_OLD = 0x01,
  LSM303D = 0x02,
  AK8963 = 0x04,
  BMM150 = 0x05,
  LSM9DS1 = 0x06,
  HMC5883 = 0x07,
  LIS3MDL = 0x08,
  AK09916 = 0x09,
  IST8310 = 0x0A,
  ICM20948 = 0x0B,
  MMC3416 = 0x0C,
  QMC5883L = 0x0D,
  MAG3110 = 0x0E,
  SITL = 0x0F,
  IST8308 = 0x10,
  RM3100 = 0x11,
  RM3100_2 = 0x12,
  MMC5883 = 0x13,
  AK09918 = 0x14,
  AK09915 = 0x15,
  QMC5883P = 0x16,
  BMM350 = 0x17,
  IIS2MDC = 0x18,
  LIS2MDL = 0x19,
}

enum IMU_TYPE {
  UNKNOWN = 0x00,
  BMI160 = 0x09,
  L3G4200D = 0x10,
  ACC_LSM303D = 0x11,
  ACC_BMA180 = 0x12,
  ACC_MPU6000 = 0x13,
  ACC_MPU9250 = 0x16,
  ACC_IIS328DQ = 0x17,
  ACC_LSM9DS1 = 0x18,
  GYR_MPU6000 = 0x21,
  GYR_L3GD20 = 0x22,
  GYR_MPU9250 = 0x24,
  GYR_I3G4250D = 0x25,
  GYR_LSM9DS1 = 0x26,
  INS_ICM20789 = 0x27,
  INS_ICM20689 = 0x28,
  INS_BMI055 = 0x29,
  SITL = 0x2A,
  INS_BMI088 = 0x2B,
  INS_ICM20948 = 0x2C,
  INS_ICM20648 = 0x2D,
  INS_ICM20649 = 0x2E,
  INS_ICM20602 = 0x2F,
  INS_ICM20601 = 0x30,
  INS_ADIS1647x = 0x31,
  INS_SERIAL = 0x32,
  INS_ICM40609 = 0x33,
  INS_ICM42688 = 0x34,
  INS_ICM42605 = 0x35,
  INS_ICM40605 = 0x36,
  INS_IIM42652 = 0x37,
  INS_BMI270 = 0x38,
  INS_BMI085 = 0x39,
  INS_ICM42670 = 0x3A,
  INS_ICM45686 = 0x3B,
  INS_SCHA63T  = 0x3C,
  INS_IIM42653 = 0x3D,
  INS_LSM6DSV  = 0x3E,
}

enum BARO_TYPE {
  UNKNOWN = 0x00,
  SITL = 0x01,
  BMP085 = 0x02,
  BMP280 = 0x03,
  BMP388 = 0x04,
  DPS280 = 0x05,
  DPS310 = 0x06,
  FBM320 = 0x07,
  ICM20789 = 0x08,
  KELLERLD = 0x09,
  LPS2XH = 0x0A,
  MS5611 = 0x0B,
  SPL06 = 0x0C,
  UAVCAN = 0x0D,
  MSP = 0x0E,
  ICP101XX = 0x0F,
  ICP201XX = 0x10,
  MS5607 = 0x11,
  MS5837_30BA = 0x12,
  MS5637 = 0x13,
  BMP390 = 0x14,
  BMP581 = 0x15,
  SPA06 = 0x16,
  AUAV = 0x17,
  MS5837_02BA = 0x18,
}

enum AIRSPEED_TYPE {
  UNKNOWN = 0x00,
  AIRSPEED_SITL = 0x01,
  AIRSPEED_MS4525 = 0x02,
  AIRSPEED_MS5525 = 0x03,
  AIRSPEED_DLVR = 0x04,
  AIRSPEED_MSP = 0x05,
  AIRSPEED_SDP3X = 0x06,
  AIRSPEED_UAVCAN = 0x07,
  AIRSPEED_ANALOG = 0x08,
  AIRSPEED_NMEA = 0x09,
  AIRSPEED_ASP5033 = 0x0A,
}

// Matches AP_GPS_Backend::DevType in ArduPilot GPS_Backend.h
enum GPS_TYPE {
  UNKNOWN = 0x00,
  UBLOX = 0x01,
  UBLOX_5 = 0x02,
  UBLOX_6 = 0x03,
  UBLOX_7 = 0x04,
  UBLOX_M8 = 0x05,
  UBLOX_M8N = 0x06,
  UBLOX_M9 = 0x07,
  UBLOX_M9N = 0x08,
  UBLOX_F9 = 0x09,
  UBLOX_F9_ZED = 0x0A,
  UBLOX_F9_NEO = 0x0B,
  UBLOX_M10 = 0x0C,
  UBLOX_F10 = 0x0D,
  UBLOX_F20 = 0x0E,
  UBLOX_X20 = 0x0F,
  NMEA = 0x20,
  SIRF = 0x21,
  SBP = 0x22,
  SBP2 = 0x23,
  ERB = 0x24,
  SBF = 0x25,
  GSOF = 0x26,
  NOVA = 0x27,
  MAV = 0x28,
  MSP = 0x29,
  EXTERNAL_AHRS = 0x2A,
  UAVCAN = 0x2B,
  SITL = 0x2C,
}

function toHex(value: number): string {
  return Number(value).toString(16).padStart(2, '0')
}

export interface deviceId {
    param: string
    paramValue: number
    deviceIdNumber: number
    deviceName?: string
    busType: BUS_TYPE
    bus: number
    address: string
    devtype: number
}

export default function decode(device: string, devid: number): deviceId {
  const busType = devid & 0x07 as BUS_TYPE
  const bus = devid >> 3 & 0x1F
  const address = devid >> 8 & 0xFF
  const devtype = devid >> 16
  // Prefer instance number from names like GPS1_DEV_ID / BARO2_DEVID; fall back to trailing digit
  const instanceMatch = device.match(/(?:GPS|BARO|TEMP|ARSPD?)(\d+)/)
  const deviceIdNumber = instanceMatch
    ? parseInt(instanceMatch[1], 10)
    : (parseInt(device.slice(-1), 10) || 1)

  let decodedDevname = 'UNKNOWN'

  if (device.startsWith('COMPASS')) {
    // When compass uses UAVCAN, the devtype is sensor_id + 1
    // So we ignore it to avoid showing up the wrong device name
    switch (busType) {
      // When compass uses UAVCAN, the devtype is sensor_id + 1
      // So we ignore it to avoid showing up the wrong device name
      case BUS_TYPE.UAVCAN:
        decodedDevname = 'UAVCAN'
        break
      // eAHRS is the only one that uses SERIAL
      case BUS_TYPE.SERIAL:
        decodedDevname = 'eAHRS'
        break
      default:
        decodedDevname = COMPASS_TYPE[devtype] || 'UNKNOWN'
    }
  }
  if (device.startsWith('INS')) {
    decodedDevname = IMU_TYPE[devtype] || 'UNKNOWN'
  }
  if (device.startsWith('GND_BARO') || device.startsWith('BARO')) {
    decodedDevname = BARO_TYPE[devtype] || 'UNKNOWN'
  }
  if (device.startsWith('ARSP')) {
    decodedDevname = AIRSPEED_TYPE[devtype] || 'UNKNOWN'
  }
  if (device.startsWith('GPS')) {
    decodedDevname = GPS_TYPE[devtype] || 'UNKNOWN'
  }
  return {
    param: device,
    deviceName: decodedDevname,
    busType,
    bus,
    address: toHex(address),
    devtype,
    deviceIdNumber,
    paramValue: devid,
  }
}

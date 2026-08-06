<template>
  <v-card class="mt-6">
    <v-card-title class="align-center">
      <v-icon left>
        mdi-chip
      </v-icon>
      Autopilot Sensors
    </v-card-title>
    <v-card-text>
      <v-simple-table dense>
        <template #default>
          <thead>
            <tr>
              <th class="text-left">
                Sensor
              </th>
              <th class="text-left">
                Type
              </th>
              <th class="text-left">
                Bus
              </th>
              <th class="text-left">
                Address
              </th>
              <th class="text-left">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="accelerometer in ardupilot_sensors.accelerometers"
              :key="accelerometer.param"
            >
              <td><b>{{ accelerometer.deviceName ?? 'UNKNOWN' }}</b></td>
              <td v-tooltip="'Inertial Navigation Sensor'">
                INS
              </td>
              <td>{{ print_bus(accelerometer.busType) }} {{ accelerometer.bus }}</td>
              <td>{{ `0x${accelerometer.address}` }}</td>
              <td>
                <v-icon
                  v-if="ardupilot_sensors.accelerometers_calibrated[accelerometer.param]"
                  v-tooltip="'Sensor is callibrated and good to use'"
                  color="green"
                >
                  mdi-emoticon-happy-outline
                </v-icon>
                <v-icon
                  v-else
                  v-tooltip="'Sensor needs to be calibrated'"
                  color="red"
                >
                  mdi-emoticon-sad-outline
                </v-icon>
                <v-icon
                  v-if="ardupilot_sensors.accelerometers_temperature_calibrated[accelerometer.param].calibrated"
                  v-tooltip="'Sensor thermometer is calibrated and good to use'"
                  color="green"
                >
                  mdi-thermometer-check
                </v-icon>
                <v-icon
                  v-else
                  v-tooltip="'Sensor thermometer needs to be calibrated'"
                  color="red"
                >
                  mdi-thermometer-off
                </v-icon>
              </td>
            </tr>
            <tr
              v-for="compass in ardupilot_sensors.compasses"
              :key="compass.param"
            >
              <td><b>{{ compass.deviceName ?? 'UNKNOWN' }}</b></td>
              <td>
                {{ compass_description[compass.param] }}
              </td>
              <td>{{ print_bus(compass.busType) }} {{ compass.bus }}</td>
              <td>{{ `0x${compass.address}` }}</td>
              <td>
                <v-icon
                  v-if="ardupilot_sensors.compass_calibrated[compass.param]"
                  v-tooltip="'Sensor is callibrated and good to use'"
                  color="green"
                >
                  mdi-emoticon-happy-outline
                </v-icon>
                <v-icon
                  v-else
                  v-tooltip="'Sensor needs to be calibrated'"
                  color="red"
                >
                  mdi-emoticon-sad-outline
                </v-icon>
              </td>
            </tr>
            <tr
              v-for="baro in ardupilot_sensors.baros"
              :key="baro.param"
            >
              <td><b>{{ baro.deviceName ?? 'UNKNOWN' }}</b></td>
              <td v-tooltip="'Used to estimate altitude/depth'">
                {{ get_pressure_type[baro.param] }} Pressure
              </td>
              <td>{{ print_bus(baro.busType) }} {{ baro.bus }}</td>
              <td>{{ `0x${baro.address}` }}</td>
              <td>{{ baro_status[baro.param] }}</td>
            </tr>
            <tr
              v-for="gps in ardupilot_sensors.gps"
              :key="gps.param"
            >
              <td><b>{{ pretty_gps_name(gps.deviceName) }}</b></td>
              <td v-tooltip="'Global Positioning System receiver'">
                GPS {{ gps.deviceIdNumber }}
              </td>
              <td>{{ print_bus(gps.busType) }} {{ gps.bus }}</td>
              <td>{{ `0x${gps.address}` }}</td>
              <td>{{ gps_status[gps.param] }}</td>
            </tr>
            <tr
              v-for="sensor in celsius"
              :key="sensor.param"
            >
              <td><b>{{ sensor.deviceName ?? 'UNKNOWN' }}</b></td>
              <td v-tooltip="'Used to estimate altitude/depth'">
                Temperature
              </td>
              <td>{{ print_bus(sensor.busType) }} {{ sensor.bus }}</td>
              <td>{{ `0x${sensor.address}` }}</td>
              <td>{{ celsius_temperature }} ºC</td>
            </tr>
          </tbody>
        </template>
      </v-simple-table>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import Vue from 'vue'

import ardupilot_sensors, { ArdupilotSensorsStore } from '@/store/ardupilot_sensors'
import autopilot_data from '@/store/autopilot'
import autopilot from '@/store/autopilot_manager'
import mavlink from '@/store/mavlink'
import { GpsFixType } from '@/libs/MAVLink2Rest/mavlink2rest-ts/messages/mavlink2rest-enum'
import { printParam } from '@/types/autopilot/parameter'
import { Dictionary } from '@/types/common'
import { BUS_TYPE, deviceId } from '@/utils/deviceid_decoder'
import mavlink_store_get from '@/utils/mavlink'

export default Vue.extend({
  name: 'OnboardSensors',
  computed: {
    // DEV_ID params do not exist yet for temperature sensors, so here we detect the incoming message instead
    celsius_temperature(): number | undefined {
      return mavlink_store_get(mavlink, 'SCALED_PRESSURE3.messageData.message.temperature') as number / 100.0
    },
    celsius(): deviceId[] {
      if (!this.celsius_temperature) {
        return []
      }
      return [
        {
          bus: 1,
          paramValue: 0,
          deviceIdNumber: 0,
          devtype: 0,
          busType: BUS_TYPE.I2C,
          address: '77',
          deviceName: 'Celsius',
          param: '-',
        },
      ]
    },
    compass_description(): Dictionary<string> {
      const results = {} as Dictionary<string>
      for (const compass of ardupilot_sensors.compasses) {
        // First we check the priority for this device
        let priority = 'Unused'
        let number_in_parameter = 0
        for (const param of autopilot_data.parameterRegex('^COMPASS_PRIO.*_ID')) {
          if (param.value === compass.paramValue) {
            const number_in_parameter_as_string = param.name.match(/\d+/g)?.[0] ?? '1'
            number_in_parameter = parseInt(number_in_parameter_as_string, 10)
            switch (number_in_parameter) {
              case 1:
                priority = '1st'
                break
              case 2:
                priority = '2nd'
                break
              case 3:
                priority = '3rd'
                break
              default:
                priority = 'Unused'
            }
          }
        }
        // Then we check if it is internal or external
        const extern_param_name = number_in_parameter === 1
          ? 'COMPASS_EXTERNAL' : `COMPASS_EXTERN${number_in_parameter}`
        const external = autopilot_data.parameter(extern_param_name)?.value === 1 ?? false
        const external_string = external ? 'external' : 'internal'
        results[compass.param] = `${priority} Compass (${external_string})`
      }
      return results
    },
    ardupilot_sensors(): ArdupilotSensorsStore {
      return ardupilot_sensors
    },
    external_i2c_bus(): number | undefined {
      return autopilot_data.parameter('BARO_EXT_BUS')?.value
    },
    is_water_baro(): Dictionary<boolean> {
      const results = {} as Dictionary<boolean>
      for (const baro of ardupilot_sensors.baros) {
        if (['MS5837_30BA', 'MS5837_02BA', 'MS5611', 'KELLERLD'].includes(baro.deviceName ?? '--')
        && autopilot.vehicle_type === 'Submarine' && baro.busType === BUS_TYPE.I2C
        && baro.bus === this.external_i2c_bus) {
          results[baro.param] = true
          continue
        }
        results[baro.param] = false
      }
      return results
    },
    baro_status(): Dictionary<string> {
      const results = {} as Dictionary<string>
      for (const baro of ardupilot_sensors.baros) {
        const radix = baro.param.replace('_DEVID', '')
        const number = parseInt(radix.replace('BARO', ''), 10)
        if (this.is_water_baro[baro.param]) {
          const value = mavlink_store_get(mavlink, 'VFR_HUD.messageData.message.alt') as number
          results[baro.param] = `${value ? value.toFixed(2) : '--'} m`
        }
        const msg = number === 1 ? 'SCALED_PRESSURE' : `SCALED_PRESSURE${number}`
        const value = mavlink_store_get(mavlink, `${msg}.messageData.message.press_abs`) as number
        results[baro.param] = `${value ? value.toFixed(2) : '--'} hPa`
      }
      return results
    },
    get_pressure_type(): Dictionary<string> {
      const results = {} as Dictionary<string>
      for (const barometer of ardupilot_sensors.baros) {
        if (!this.is_water_baro[barometer.param]) {
          results[barometer.param] = 'Barometric'
        } else {
          const spec_gravity_param = autopilot_data.parameter('BARO_SPEC_GRAV')
          results[barometer.param] = printParam(spec_gravity_param)
        }
      }
      return results
    },
    gps_status(): Dictionary<string> {
      const results = {} as Dictionary<string>
      for (const gps of ardupilot_sensors.gps) {
        const msg = gps.deviceIdNumber === 1 ? 'GPS_RAW_INT' : 'GPS2_RAW'
        const fix_type = mavlink_store_get(mavlink, `${msg}.messageData.message.fix_type.type`) as string | undefined
        const satellites = mavlink_store_get(mavlink, `${msg}.messageData.message.satellites_visible`) as number | undefined
        results[gps.param] = `${this.fix_type_label(fix_type)}, ${satellites ?? '--'} sats`
      }
      return results
    },
  },
  mounted() {
    mavlink.setMessageRefreshRate({ messageName: 'SCALED_PRESSURE$', refreshRate: 1 })
    mavlink.setMessageRefreshRate({ messageName: 'SCALED_PRESSURE2$', refreshRate: 1 })
    mavlink.setMessageRefreshRate({ messageName: 'SCALED_PRESSURE3$', refreshRate: 1 })
    mavlink.setMessageRefreshRate({ messageName: 'VFR_HUD', refreshRate: 1 })
    mavlink.setMessageRefreshRate({ messageName: 'GPS_RAW_INT', refreshRate: 1 })
    mavlink.setMessageRefreshRate({ messageName: 'GPS2_RAW', refreshRate: 1 })
  },
  methods: {
    print_bus(bus: BUS_TYPE): string {
      return BUS_TYPE[bus]
    },
    pretty_gps_name(name: string | undefined): string {
      if (!name || name === 'UNKNOWN') {
        return 'UNKNOWN'
      }
      // UBLOX_F9_ZED → u-blox ZED-F9P, UBLOX_M8N → u-blox M8N, etc.
      if (name === 'UBLOX_F9_ZED') {
        return 'u-blox ZED-F9P'
      }
      if (name === 'UBLOX_F9_NEO') {
        return 'u-blox NEO-F9P'
      }
      if (name.startsWith('UBLOX_')) {
        return `u-blox ${name.slice('UBLOX_'.length)}`
      }
      if (name === 'UBLOX') {
        return 'u-blox'
      }
      if (name === 'UAVCAN') {
        return 'DroneCAN'
      }
      if (name === 'EXTERNAL_AHRS') {
        return 'External AHRS'
      }
      return name
    },
    fix_type_label(fix_type: string | undefined): string {
      switch (fix_type) {
        case GpsFixType.GPS_FIX_TYPE_NO_GPS:
          return 'No GPS'
        case GpsFixType.GPS_FIX_TYPE_NO_FIX:
          return 'No fix'
        case GpsFixType.GPS_FIX_TYPE_2D_FIX:
          return '2D'
        case GpsFixType.GPS_FIX_TYPE_3D_FIX:
          return '3D'
        case GpsFixType.GPS_FIX_TYPE_DGPS:
          return 'DGPS'
        case GpsFixType.GPS_FIX_TYPE_RTK_FLOAT:
          return 'RTK float'
        case GpsFixType.GPS_FIX_TYPE_RTK_FIXED:
          return 'RTK fixed'
        case GpsFixType.GPS_FIX_TYPE_STATIC:
          return 'Static'
        case GpsFixType.GPS_FIX_TYPE_PPP:
          return 'PPP'
        default:
          return 'Detected'
      }
    },
  },
})
</script>

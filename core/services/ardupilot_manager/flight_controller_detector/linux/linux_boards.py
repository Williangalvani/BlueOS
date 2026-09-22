import os
import pathlib
import subprocess
import time
from typing import ClassVar, List, Type

from loguru import logger
from smbus2 import SMBus
from typedefs import FlightController, PlatformType, Serial


class LinuxFlightController(FlightController):
    """Linux-based Flight-controller board."""

    CAN_INTERFACE: ClassVar[str] = "can0"
    BABEL_SERIAL_GLOB: ClassVar[str] = "/dev/serial/by-id/*Babel*"
    STANDARD_SCRIPT_DIRECTORY_PATH: ClassVar[str] = "/root/.config/ardupilot-manager/firmware/scripts"
    LUA_SCRIPT_DIRECTORY_PATH: ClassVar[str] = "/shortcuts/lua_scripts"

    @property
    def type(self) -> PlatformType:
        return PlatformType.Linux

    def detect(self) -> bool:
        raise NotImplementedError

    def get_serials(self) -> List[Serial]:
        raise NotImplementedError

    def check_for_i2c_device(self, bus_number: int, address: int) -> bool:
        try:
            with SMBus(bus_number) as bus:
                bus.read_byte_data(address, 0)
            return True
        except OSError:
            return False

    def setup_can(self) -> None:
        try:
            can_path = pathlib.Path("/sys/class/net") / self.CAN_INTERFACE
            if can_path.exists():
                # Only a real controller has a parent device and accepts bittiming; slcan netdevs do not.
                if (can_path / "device").exists():
                    subprocess.run(["ip", "link", "set", self.CAN_INTERFACE, "down"], check=True)
                    subprocess.run(
                        [
                            "ip",
                            "link",
                            "set",
                            self.CAN_INTERFACE,
                            "up",
                            "type",
                            "can",
                            "bitrate",
                            "1000000",
                            "restart-ms",
                            "100",
                            "loopback",
                            "off",
                        ],
                        check=True,
                    )
                else:
                    subprocess.run(["ip", "link", "set", self.CAN_INTERFACE, "up"], check=True)
                return

            babel_serials = sorted(pathlib.Path("/").glob(self.BABEL_SERIAL_GLOB.removeprefix("/")))
            if not babel_serials:
                return

            babel_serial = str(babel_serials[0])
            # -hupcl keeps DTR asserted when we close the port, so the Babel stays in the channel we just opened.
            subprocess.run(["stty", "-F", babel_serial, "3000000", "raw", "-echo", "-hupcl", "clocal"], check=True)
            with open(babel_serial, "wb", buffering=0) as serial:
                serial.write(b"C\rS8\rO\r")
            # 17 is N_SLCAN, which util-linux has no name for. ldattach daemonizes once the discipline is attached.
            attach = subprocess.run(["ldattach", "17", babel_serial], capture_output=True, text=True, check=False)
            if attach.returncode != 0:
                raise RuntimeError(f"ldattach failed: {attach.stderr.strip()}")

            slcan_path = pathlib.Path("/sys/class/net/slcan0")
            for _ in range(100):
                if can_path.exists() or slcan_path.exists():
                    break
                time.sleep(0.05)
            if slcan_path.exists():
                subprocess.run(["ip", "link", "set", "slcan0", "name", self.CAN_INTERFACE], check=True)
            elif not can_path.exists():
                raise RuntimeError("SLCAN interface did not appear")
            subprocess.run(["ip", "link", "set", self.CAN_INTERFACE, "up"], check=True)
            logger.info(f"Configured BabelCAN on {self.CAN_INTERFACE}.")
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            logger.warning(f"Failed to configure CAN: {error}")

    def setup(self) -> None:
        self.setup_can()
        os.makedirs(self.STANDARD_SCRIPT_DIRECTORY_PATH, exist_ok=True)
        try:
            os.symlink(self.STANDARD_SCRIPT_DIRECTORY_PATH, self.LUA_SCRIPT_DIRECTORY_PATH)
        except FileExistsError:
            pass

    @classmethod
    def get_all_boards(cls) -> List[Type["LinuxFlightController"]]:
        all_subclasses = []

        for subclass in cls.__subclasses__():
            all_subclasses.append(subclass)
            all_subclasses.extend(subclass.get_all_boards())

        return all_subclasses

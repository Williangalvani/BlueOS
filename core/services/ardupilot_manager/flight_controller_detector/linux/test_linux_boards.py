import pathlib
import subprocess
from typing import Any, Callable, List, Optional
from unittest.mock import mock_open

import pytest
from flight_controller_detector.linux.linux_boards import LinuxFlightController
from loguru import logger
from typedefs import Platform

# "lo" is used as a stand-in for a present interface so the sysfs probe runs for real
pytestmark = pytest.mark.skipif(
    not pathlib.Path("/sys/class/net/lo").exists(),
    reason="requires sysfs network interfaces",
)


def make_board() -> LinuxFlightController:
    return LinuxFlightController(name="Test", platform=Platform.Navigator)


def record_ip_calls(
    monkeypatch: pytest.MonkeyPatch,
    fail: bool = False,
    ldattach_returncode: int = 0,
    on_ldattach: Optional[Callable[[], None]] = None,
) -> List[List[str]]:
    calls: List[List[str]] = []

    def fake_run(arguments: List[str], **_kwargs: Any) -> "subprocess.CompletedProcess[str]":
        calls.append(arguments)
        if fail:
            raise subprocess.CalledProcessError(1, arguments)
        if arguments[0] != "ldattach":
            return subprocess.CompletedProcess(arguments, 0, stdout="", stderr="")
        if on_ldattach:
            on_ldattach()
        return subprocess.CompletedProcess(arguments, ldattach_returncode, stdout="", stderr="cannot open device")

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def test_setup_can_skips_missing_interface(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(LinuxFlightController, "CAN_INTERFACE", "blueos-no-such-can")
    monkeypatch.setattr(pathlib.Path, "glob", lambda _self, _pattern: [])
    calls = record_ip_calls(monkeypatch)

    make_board().setup_can()

    assert not calls


def test_setup_can_configures_present_interface(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(LinuxFlightController, "CAN_INTERFACE", "lo")
    original_exists = pathlib.Path.exists
    monkeypatch.setattr(
        pathlib.Path,
        "exists",
        lambda path: str(path) == "/sys/class/net/lo/device" or original_exists(path),
    )
    calls = record_ip_calls(monkeypatch)

    make_board().setup_can()

    assert [call[:5] for call in calls] == [
        ["ip", "link", "set", "lo", "down"],
        ["ip", "link", "set", "lo", "up"],
    ]
    # A stale loopback mode has to be cleared, and a real controller has to recover from bus-off on its own.
    # Neither applies to the slcan path below, where the kernel driver exposes no bittiming to configure.
    assert calls[1][5:] == [
        "type",
        "can",
        "bitrate",
        "1000000",
        "restart-ms",
        "100",
        "loopback",
        "off",
    ]


def test_setup_can_failure_does_not_block_autopilot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(LinuxFlightController, "CAN_INTERFACE", "lo")
    original_exists = pathlib.Path.exists
    monkeypatch.setattr(
        pathlib.Path,
        "exists",
        lambda path: str(path) == "/sys/class/net/lo/device" or original_exists(path),
    )
    record_ip_calls(monkeypatch, fail=True)

    make_board().setup_can()


def test_setup_can_attaches_babel_with_ldattach(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    babel = pathlib.Path("/dev/serial/by-id/usb-CUAV_CUAV_CAN_Babel-if00")
    monkeypatch.setattr(pathlib.Path, "glob", lambda _self, _pattern: [babel])
    monkeypatch.setattr(
        pathlib.Path,
        "exists",
        lambda path: str(path) == "/sys/class/net/slcan0",
    )
    serial = mock_open()
    monkeypatch.setattr("builtins.open", serial)
    calls = record_ip_calls(monkeypatch)

    make_board().setup_can()

    serial().write.assert_called_once_with(b"C\rS8\rO\r")
    assert calls == [
        ["stty", "-F", str(babel), "3000000", "raw", "-echo", "-hupcl", "clocal"],
        ["ldattach", "17", str(babel)],
        ["ip", "link", "set", "slcan0", "name", "can0"],
        ["ip", "link", "set", "can0", "up"],
    ]


def test_setup_can_accepts_kernel_naming_slcan_as_can0(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    babel = pathlib.Path("/dev/serial/by-id/usb-CUAV_CUAV_CAN_Babel-if00")
    interface_created = False

    def path_exists(path: pathlib.Path) -> bool:
        return interface_created and str(path) == "/sys/class/net/can0"

    def create_interface() -> None:
        nonlocal interface_created
        interface_created = True

    monkeypatch.setattr(pathlib.Path, "glob", lambda _self, _pattern: [babel])
    monkeypatch.setattr(pathlib.Path, "exists", path_exists)
    monkeypatch.setattr("builtins.open", mock_open())
    calls = record_ip_calls(monkeypatch, on_ldattach=create_interface)

    make_board().setup_can()

    assert calls == [
        ["stty", "-F", str(babel), "3000000", "raw", "-echo", "-hupcl", "clocal"],
        ["ldattach", "17", str(babel)],
        ["ip", "link", "set", "can0", "up"],
    ]


def test_setup_can_reports_why_ldattach_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    babel = pathlib.Path("/dev/serial/by-id/usb-CUAV_CUAV_CAN_Babel-if00")
    monkeypatch.setattr(pathlib.Path, "glob", lambda _self, _pattern: [babel])
    monkeypatch.setattr(pathlib.Path, "exists", lambda _path: False)
    monkeypatch.setattr("builtins.open", mock_open())
    calls = record_ip_calls(monkeypatch, ldattach_returncode=1)
    warnings: List[str] = []
    handler = logger.add(warnings.append, level="WARNING")

    try:
        make_board().setup_can()
    finally:
        logger.remove(handler)

    # Without the exit-code check this instead polls sysfs for five seconds and blames the missing interface
    assert "cannot open device" in "".join(warnings)
    assert [call[0] for call in calls] == ["stty", "ldattach"]

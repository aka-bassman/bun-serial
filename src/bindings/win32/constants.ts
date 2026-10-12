// Win32 constants and struct layouts (64-bit Windows). Pure data, importable
// on any OS.

// CreateFileW. GENERIC_READ has bit 31 set, and in JavaScript
// `GENERIC_READ | GENERIC_WRITE` is a negative int32 that CreateFileW reads as
// a different access mask: the open succeeds, then every ReadFile/WriteFile
// fails with ERROR_ACCESS_DENIED. Hence `>>> 0`, once, here.
export const GENERIC_READ_WRITE = (0x80000000 | 0x40000000) >>> 0
export const OPEN_EXISTING = 3
export const FILE_FLAG_OVERLAPPED = 0x40000000

// Win32 error codes this binding branches on.
export const ERROR_SUCCESS = 0
export const ERROR_INVALID_FUNCTION = 1
export const ERROR_FILE_NOT_FOUND = 2
export const ERROR_PATH_NOT_FOUND = 3
export const ERROR_ACCESS_DENIED = 5
export const ERROR_INVALID_HANDLE = 6
export const ERROR_NOT_READY = 21
export const ERROR_BAD_COMMAND = 22
export const ERROR_GEN_FAILURE = 31
export const ERROR_SHARING_VIOLATION = 32
export const ERROR_NOT_SUPPORTED = 50
export const ERROR_DEV_NOT_EXIST = 55
export const ERROR_INVALID_PARAMETER = 87
export const ERROR_INVALID_NAME = 123
export const ERROR_NO_SUCH_DEVICE = 433
export const ERROR_OPERATION_ABORTED = 995
export const ERROR_IO_INCOMPLETE = 996
export const ERROR_IO_PENDING = 997
export const ERROR_DEVICE_NOT_CONNECTED = 1167
export const ERROR_DEVICE_REMOVED = 1617

/** OVERLAPPED.Internal while the I/O is in flight (the HasOverlappedIoCompleted test). */
export const STATUS_PENDING = 0x103

export const FORMAT_MESSAGE_FLAGS = (0x1000 | 0x200) >>> 0 // FROM_SYSTEM | IGNORE_INSERTS

// struct DCB — 28 bytes.
export const DCB = {
  size: 28,
  DCBlength: 0,
  BaudRate: 4,
  flags: 8,
  XonLim: 14,
  XoffLim: 16,
  ByteSize: 18,
  Parity: 19,
  StopBits: 20,
  XonChar: 21,
  XoffChar: 22,
} as const

// The DCB bitfield DWORD at offset 8, least significant bit first.
export const fBinary = 1 << 0
export const fParity = 1 << 1
export const fOutxCtsFlow = 1 << 2
export const fOutxDsrFlow = 1 << 3
export const fDtrControlShift = 4 // 2 bits
export const fDsrSensitivity = 1 << 6
export const fTXContinueOnXoff = 1 << 7
export const fOutX = 1 << 8
export const fInX = 1 << 9
export const fErrorChar = 1 << 10
export const fNull = 1 << 11
export const fRtsControlShift = 12 // 2 bits
export const fAbortOnError = 1 << 14

export const DTR_CONTROL_DISABLE = 0
export const DTR_CONTROL_ENABLE = 1
export const RTS_CONTROL_DISABLE = 0
export const RTS_CONTROL_ENABLE = 1
export const RTS_CONTROL_HANDSHAKE = 2

export const NOPARITY = 0
export const ODDPARITY = 1
export const EVENPARITY = 2
export const MARKPARITY = 3
export const SPACEPARITY = 4

export const ONESTOPBIT = 0
export const ONE5STOPBITS = 1
export const TWOSTOPBITS = 2

export const XON = 0x11
export const XOFF = 0x13

// struct COMMTIMEOUTS — five DWORDs.
export const COMMTIMEOUTS_SIZE = 20
export const MAXDWORD = 0xffffffff

// struct COMSTAT — a DWORD of flags, then cbInQue and cbOutQue.
export const COMSTAT = { size: 12, cbInQue: 4, cbOutQue: 8 } as const

// struct OVERLAPPED — Internal, InternalHigh, Offset/OffsetHigh, hEvent.
export const OVERLAPPED = { size: 32, Internal: 0, hEvent: 24 } as const

// EscapeCommFunction
export const SETRTS = 3
export const CLRRTS = 4
export const SETDTR = 5
export const CLRDTR = 6
export const SETBREAK = 8
export const CLRBREAK = 9

// GetCommModemStatus
export const MS_CTS_ON = 0x10
export const MS_DSR_ON = 0x20
export const MS_RING_ON = 0x40
export const MS_RLSD_ON = 0x80

// PurgeComm. No PURGE_*ABORT: that would fail our own pending reads and writes.
export const PURGE_TXCLEAR = 0x4
export const PURGE_RXCLEAR = 0x8

// SetupAPI. GUID_DEVCLASS_PORTS {4d36e978-e325-11ce-bfc1-08002be10318} as a
// GUID struct: Data1 u32, Data2 u16, Data3 u16 little-endian, then Data4 bytes.
export const GUID_DEVCLASS_PORTS = Uint8Array.of(
  0x78, 0xe9, 0x36, 0x4d,
  0x25, 0xe3,
  0xce, 0x11,
  0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18,
)
export const DIGCF_PRESENT = 0x2
// SP_DEVINFO_DATA: cbSize, ClassGuid, DevInst, then a pointer-aligned Reserved.
export const SP_DEVINFO_DATA = { size: 32, DevInst: 20 } as const
export const SPDRP_DEVICEDESC = 0x0
export const SPDRP_MFG = 0xb
export const SPDRP_LOCATION_INFORMATION = 0xd
export const DICS_FLAG_GLOBAL = 1
export const DIREG_DEV = 1
export const KEY_READ = 0x20019
export const CR_SUCCESS = 0
export const CM_DRP_LOCATION_INFORMATION = 0xe // SPDRP_LOCATION_INFORMATION + 1

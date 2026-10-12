// Kernel and libc constants for the two POSIX platforms, behind one interface
// so the rest of the binding never branches on the OS. Linux values are the
// asm-generic ones shared by x86_64 and aarch64 — the only Linux targets Bun
// ships for. Pure data: importable on any OS (tests check both tables).

export interface TermiosLayout {
  /** sizeof(struct termios) */
  readonly size: number
  /** tcflag_t width: unsigned int on Linux, unsigned long on macOS. */
  readonly flagSize: 4 | 8
  readonly iflag: number
  readonly oflag: number
  readonly cflag: number
  readonly lflag: number
  readonly cc: number
}

/** epoll, through which a worker waits for every open port (poller.ts). */
export interface EpollConstants {
  readonly kind: 'epoll'
  readonly EPOLL_CLOEXEC: number
  readonly EPOLL_CTL_ADD: number
  readonly EPOLL_CTL_DEL: number
  readonly EPOLL_CTL_MOD: number
  readonly EPOLLIN: number
  readonly EPOLLOUT: number
  readonly EPOLLERR: number
  readonly EPOLLHUP: number
  readonly EPOLLONESHOT: number
}

/** kqueue, through which a worker waits for every open port (poller.ts). */
export interface KqueueConstants {
  readonly kind: 'kqueue'
  readonly EVFILT_READ: number
  readonly EVFILT_WRITE: number
  readonly EV_ADD: number
  readonly EV_ONESHOT: number
}

export interface PosixConstants {
  readonly platform: 'linux' | 'darwin'
  /** libc candidates, tried in order (glibc first, then musl on Linux). */
  readonly libc: readonly string[]
  readonly errnoSymbol: '__errno_location' | '__error'

  readonly O_RDWR: number
  readonly O_NOCTTY: number
  readonly O_NONBLOCK: number
  readonly O_CLOEXEC: number
  readonly LOCK_EX: number
  readonly LOCK_NB: number

  readonly errno: {
    readonly EPERM: number
    readonly ENOENT: number
    readonly EINTR: number
    readonly EIO: number
    readonly ENXIO: number
    readonly EAGAIN: number
    readonly EACCES: number
    readonly EBUSY: number
    readonly EEXIST: number
    readonly ENODEV: number
    readonly EINVAL: number
    readonly ENOTTY: number
  }

  readonly TCSANOW: number
  readonly TCOFLUSH: number
  readonly TCIOFLUSH: number

  // c_cflag
  readonly CSIZE: number
  readonly CS5: number
  readonly CS6: number
  readonly CS7: number
  readonly CS8: number
  readonly CSTOPB: number
  readonly CREAD: number
  readonly PARENB: number
  readonly PARODD: number
  readonly HUPCL: number
  readonly CLOCAL: number
  readonly CRTSCTS: number
  /** Mark/space parity. 0 where unsupported (macOS). */
  readonly CMSPAR: number

  // c_iflag
  readonly IGNPAR: number
  readonly INPCK: number
  readonly IXON: number
  readonly IXOFF: number
  readonly IXANY: number

  // c_cc
  readonly VMIN: number
  readonly VTIME: number
  readonly NCCS: number

  // ioctl requests and TIOCM_* line bits
  readonly TIOCMGET: number
  readonly TIOCMBIS: number
  readonly TIOCMBIC: number
  readonly TIOCSBRK: number
  readonly TIOCCBRK: number
  readonly TIOCOUTQ: number
  readonly TIOCM_DTR: number
  readonly TIOCM_RTS: number
  readonly TIOCM_CTS: number
  readonly TIOCM_CD: number
  readonly TIOCM_RI: number
  readonly TIOCM_DSR: number
  /** Set close-on-exec: an ioctl taking no argument, unlike fcntl's integer one. */
  readonly FIOCLEX: number

  readonly poller: EpollConstants | KqueueConstants

  readonly termios: TermiosLayout
  /**
   * cfsetispeed/cfsetospeed argument for each rate the classic API takes.
   * Linux uses Bxxx codes, macOS the literal rate. Anything missing goes
   * through the custom-rate path below.
   */
  readonly speeds: ReadonlyMap<number, number>

  /** Linux custom rates: struct termios2 with BOTHER, set by raw ioctl. */
  readonly termios2?: {
    readonly size: number
    readonly cflag: number
    readonly ispeed: number
    readonly ospeed: number
    readonly TCGETS2: number
    readonly TCSETS2: number
    readonly BOTHER: number
    readonly CBAUD: number
    /** CIBAUD is CBAUD shifted up by this much. */
    readonly IBSHIFT: number
  }
  /** macOS custom rates: _IOW('T', 2, speed_t), which takes the literal rate. */
  readonly IOSSIOSPEED?: number
}

const LINUX_SPEEDS: ReadonlyMap<number, number> = new Map([
  [50, 0o1], [75, 0o2], [110, 0o3], [134, 0o4], [150, 0o5], [200, 0o6], [300, 0o7],
  [600, 0o10], [1200, 0o11], [1800, 0o12], [2400, 0o13], [4800, 0o14], [9600, 0o15],
  [19200, 0o16], [38400, 0o17], [57600, 0o10001], [115200, 0o10002], [230400, 0o10003],
  [460800, 0o10004], [500000, 0o10005], [576000, 0o10006], [921600, 0o10007],
  [1000000, 0o10010], [1152000, 0o10011], [1500000, 0o10012], [2000000, 0o10013],
  [2500000, 0o10014], [3000000, 0o10015], [3500000, 0o10016], [4000000, 0o10017],
])

// The rates with a Bxxx constant in macOS <termios.h>. Others (460800,
// 921600, ...) need IOSSIOSPEED: the tty layer passes them through, but
// drivers commonly reject them from tcsetattr.
const DARWIN_SPEEDS: ReadonlyMap<number, number> = new Map(
  [50, 75, 110, 134, 150, 200, 300, 600, 1200, 1800, 2400, 4800, 7200, 9600, 14400, 19200,
    28800, 38400, 57600, 76800, 115200, 230400].map((rate) => [rate, rate]),
)

export const linuxConstants: PosixConstants = {
  platform: 'linux',
  libc: ['libc.so.6', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1'],
  errnoSymbol: '__errno_location',

  O_RDWR: 0o2,
  O_NOCTTY: 0o400,
  O_NONBLOCK: 0o4000,
  O_CLOEXEC: 0o2000000,
  LOCK_EX: 2,
  LOCK_NB: 4,

  errno: {
    EPERM: 1, ENOENT: 2, EINTR: 4, EIO: 5, ENXIO: 6, EAGAIN: 11, EACCES: 13, EBUSY: 16,
    EEXIST: 17, ENODEV: 19, EINVAL: 22, ENOTTY: 25,
  },

  TCSANOW: 0,
  TCOFLUSH: 1,
  TCIOFLUSH: 2,

  CSIZE: 0o60,
  CS5: 0o0,
  CS6: 0o20,
  CS7: 0o40,
  CS8: 0o60,
  CSTOPB: 0o100,
  CREAD: 0o200,
  PARENB: 0o400,
  PARODD: 0o1000,
  HUPCL: 0o2000,
  CLOCAL: 0o4000,
  CRTSCTS: 0o20000000000,
  CMSPAR: 0o10000000000,

  IGNPAR: 0o4,
  INPCK: 0o20,
  IXON: 0o2000,
  IXOFF: 0o10000,
  IXANY: 0o4000,

  VMIN: 6,
  VTIME: 5,
  NCCS: 32,

  TIOCMGET: 0x5415,
  TIOCMBIS: 0x5416,
  TIOCMBIC: 0x5417,
  TIOCSBRK: 0x5427,
  TIOCCBRK: 0x5428,
  TIOCOUTQ: 0x5411,
  TIOCM_DTR: 0x002,
  TIOCM_RTS: 0x004,
  TIOCM_CTS: 0x020,
  TIOCM_CD: 0x040,
  TIOCM_RI: 0x080,
  TIOCM_DSR: 0x100,
  FIOCLEX: 0x5451,

  poller: {
    kind: 'epoll',
    EPOLL_CLOEXEC: 0o2000000,
    EPOLL_CTL_ADD: 1,
    EPOLL_CTL_DEL: 2,
    EPOLL_CTL_MOD: 3,
    EPOLLIN: 0x001,
    EPOLLOUT: 0x004,
    EPOLLERR: 0x008,
    EPOLLHUP: 0x010,
    EPOLLONESHOT: 0x40000000,
  },

  // glibc/musl struct termios: 4 flags, c_line, c_cc[32], 3 bytes padding,
  // c_ispeed, c_ospeed — 60 bytes.
  termios: { size: 60, flagSize: 4, iflag: 0, oflag: 4, cflag: 8, lflag: 12, cc: 17 },
  speeds: LINUX_SPEEDS,

  // Kernel struct termios2: 4 flags, c_line, c_cc[19], c_ispeed, c_ospeed — 44 bytes.
  termios2: {
    size: 44,
    cflag: 8,
    ispeed: 36,
    ospeed: 40,
    TCGETS2: 0x802c542a,
    TCSETS2: 0x402c542b,
    BOTHER: 0o10000,
    CBAUD: 0o10017,
    IBSHIFT: 16,
  },
}

export const darwinConstants: PosixConstants = {
  platform: 'darwin',
  libc: ['libSystem.B.dylib'],
  errnoSymbol: '__error',

  O_RDWR: 0x2,
  O_NOCTTY: 0x20000,
  O_NONBLOCK: 0x4,
  O_CLOEXEC: 0x1000000,
  LOCK_EX: 2,
  LOCK_NB: 4,

  errno: {
    EPERM: 1, ENOENT: 2, EINTR: 4, EIO: 5, ENXIO: 6, EAGAIN: 35, EACCES: 13, EBUSY: 16,
    EEXIST: 17, ENODEV: 19, EINVAL: 22, ENOTTY: 25,
  },

  TCSANOW: 0,
  TCOFLUSH: 2,
  TCIOFLUSH: 3,

  CSIZE: 0x300,
  CS5: 0x000,
  CS6: 0x100,
  CS7: 0x200,
  CS8: 0x300,
  CSTOPB: 0x400,
  CREAD: 0x800,
  PARENB: 0x1000,
  PARODD: 0x2000,
  HUPCL: 0x4000,
  CLOCAL: 0x8000,
  CRTSCTS: 0x30000, // CCTS_OFLOW | CRTS_IFLOW
  CMSPAR: 0,

  IGNPAR: 0x4,
  INPCK: 0x10,
  IXON: 0x200,
  IXOFF: 0x400,
  IXANY: 0x800,

  VMIN: 16,
  VTIME: 17,
  NCCS: 20,

  TIOCMGET: 0x4004746a,
  TIOCMBIS: 0x8004746c,
  TIOCMBIC: 0x8004746b,
  TIOCSBRK: 0x2000747b,
  TIOCCBRK: 0x2000747a,
  TIOCOUTQ: 0x40047473,
  TIOCM_DTR: 0x002,
  TIOCM_RTS: 0x004,
  TIOCM_CTS: 0x020,
  TIOCM_CD: 0x040,
  TIOCM_RI: 0x080,
  TIOCM_DSR: 0x100,
  FIOCLEX: 0x20006601,

  poller: {
    kind: 'kqueue',
    EVFILT_READ: -1,
    EVFILT_WRITE: -2,
    EV_ADD: 0x0001,
    EV_ONESHOT: 0x0010,
  },

  // 4 unsigned-long flags, c_cc[20], 4 bytes padding, c_ispeed, c_ospeed — 72 bytes.
  termios: { size: 72, flagSize: 8, iflag: 0, oflag: 8, cflag: 16, lflag: 24, cc: 32 },
  speeds: DARWIN_SPEEDS,

  IOSSIOSPEED: 0x80085402,
}

export function posixConstants(platform: 'linux' | 'darwin'): PosixConstants {
  return platform === 'linux' ? linuxConstants : darwinConstants
}

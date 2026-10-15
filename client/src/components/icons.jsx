/**
 * Icon set.
 *
 * Hand-rolled on a single grid — 24×24 box, 1.75 stroke, round caps and joins —
 * so every glyph shares the same optical weight. No icon dependency: it keeps
 * the bundle small and guarantees one drawing style rather than three libraries
 * blended together, which is what makes an interface look assembled instead of
 * designed.
 *
 * Icons are decorative by default (`aria-hidden`). When an icon is the *only*
 * content of a control, the control gets the accessible name, not the icon.
 */
function Icon({ children, size = 16, strokeWidth = 1.75, className, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (p) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </Icon>
);

export const CartIcon = (p) => (
  <Icon {...p}>
    <path d="M2.5 3h2.2l2.3 11.3a1.7 1.7 0 0 0 1.7 1.4h8.4a1.7 1.7 0 0 0 1.7-1.3L20.5 7H6" />
    <circle cx="9.5" cy="20" r="1.4" />
    <circle cx="17.5" cy="20" r="1.4" />
  </Icon>
);

export const BagIcon = (p) => (
  <Icon {...p}>
    <path d="M4 7h16l-1.2 12.1A2 2 0 0 1 16.8 21H7.2a2 2 0 0 1-2-1.9L4 7Z" />
    <path d="M8.5 10V6.5a3.5 3.5 0 0 1 7 0V10" />
  </Icon>
);

export const BoxIcon = (p) => (
  <Icon {...p}>
    <path d="m12 2.6 8 4.2v10.4l-8 4.2-8-4.2V6.8l8-4.2Z" />
    <path d="m4.3 6.9 7.7 4 7.7-4" />
    <path d="M12 11v10.4" />
  </Icon>
);

export const GridIcon = (p) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
  </Icon>
);

export const ReceiptIcon = (p) => (
  <Icon {...p}>
    <path d="M5 3h14v18l-2.3-1.6L14.4 21 12 19.4 9.6 21l-2.3-1.6L5 21V3Z" />
    <path d="M9 8h6M9 12h6" />
  </Icon>
);

export const GaugeIcon = (p) => (
  <Icon {...p}>
    <path d="M4 18a8 8 0 1 1 16 0" />
    <path d="m12 14 4-4" />
    <circle cx="12" cy="18" r="1.2" />
  </Icon>
);

export const PulseIcon = (p) => (
  <Icon {...p}>
    <path d="M3 12h3.5l2-5 3 10 2.5-7 1.8 2h5.2" />
  </Icon>
);

export const ShieldIcon = (p) => (
  <Icon {...p}>
    <path d="M12 2.8 20 6v6c0 5-3.4 8.4-8 9.6C7.4 20.4 4 17 4 12V6l8-3.2Z" />
    <path d="m9 12 2.2 2.2L15.4 10" />
  </Icon>
);

export const SunIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </Icon>
);

export const MoonIcon = (p) => (
  <Icon {...p}>
    <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z" />
  </Icon>
);

export const MonitorIcon = (p) => (
  <Icon {...p}>
    <rect x="2.5" y="4" width="19" height="12.5" rx="1.8" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </Icon>
);

export const CheckIcon = (p) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const CheckCircleIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.4 12.2 2.4 2.4 4.8-5" />
  </Icon>
);

export const AlertTriangleIcon = (p) => (
  <Icon {...p}>
    <path d="M10.3 3.9 2.6 17.2A1.9 1.9 0 0 0 4.3 20h15.4a1.9 1.9 0 0 0 1.7-2.8L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" />
    <path d="M12 9v4.2" />
    <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const AlertCircleIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.2" />
    <circle cx="12" cy="16.2" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const InfoIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.9" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const XIcon = (p) => (
  <Icon {...p}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </Icon>
);

export const CloseIcon = XIcon;

export const PlusIcon = (p) => (
  <Icon {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Icon>
);

export const MinusIcon = (p) => (
  <Icon {...p}>
    <path d="M5.5 12h13" />
  </Icon>
);

export const TrashIcon = (p) => (
  <Icon {...p}>
    <path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
    <path d="M6.2 7l.9 12.1A1.9 1.9 0 0 0 9 21h6a1.9 1.9 0 0 0 1.9-1.9L17.8 7" />
    <path d="M10.5 11v6M13.5 11v6" />
  </Icon>
);

export const RefreshIcon = (p) => (
  <Icon {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M20.5 4v5.2h-5.2" />
  </Icon>
);

export const ChevronRightIcon = (p) => (
  <Icon {...p}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </Icon>
);

export const ChevronDownIcon = (p) => (
  <Icon {...p}>
    <path d="m5.5 9 6.5 6.5L18.5 9" />
  </Icon>
);

export const ArrowRightIcon = (p) => (
  <Icon {...p}>
    <path d="M4.5 12h14M13 6.5l5.5 5.5L13 17.5" />
  </Icon>
);

export const ClockIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.4V12l3.2 2" />
  </Icon>
);

export const UserIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="8.4" r="3.9" />
    <path d="M4.8 20.2a7.6 7.6 0 0 1 14.4 0" />
  </Icon>
);

export const LockIcon = (p) => (
  <Icon {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
  </Icon>
);

export const EyeIcon = (p) => (
  <Icon {...p}>
    <path d="M2.5 12S5.8 6 12 6s9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.6" />
  </Icon>
);

export const EyeOffIcon = (p) => (
  <Icon {...p}>
    <path d="M4 4.5l16 15" />
    <path d="M9.6 6.4A9.6 9.6 0 0 1 12 6c6.2 0 9.5 6 9.5 6a17 17 0 0 1-3.3 3.7" />
    <path d="M6.3 8.3A16.4 16.4 0 0 0 2.5 12s3.3 6 9.5 6a9.9 9.9 0 0 0 3.5-.6" />
    <path d="M10.3 10.4a2.6 2.6 0 0 0 3.4 3.6" />
  </Icon>
);

export const MenuIcon = (p) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const LogoutIcon = (p) => (
  <Icon {...p}>
    <path d="M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5" />
    <path d="M15 8.5 18.5 12 15 15.5M8.5 12h10" />
  </Icon>
);

export const DatabaseIcon = (p) => (
  <Icon {...p}>
    <ellipse cx="12" cy="6" rx="7.5" ry="3" />
    <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
    <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
  </Icon>
);

export const BoltIcon = (p) => (
  <Icon {...p}>
    <path d="M13.5 2.5 5 13.2h6l-.8 8.3L19 10.7h-6l.5-8.2Z" />
  </Icon>
);

export const TrendUpIcon = (p) => (
  <Icon {...p}>
    <path d="M3.5 16.5 9 11l3.5 3.5L20.5 6" />
    <path d="M15.5 6h5v5" />
  </Icon>
);

export const LayersIcon = (p) => (
  <Icon {...p}>
    <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
    <path d="m4 12 8 4.3 8-4.3" />
    <path d="m4 16.5 8 4.3 8-4.3" />
  </Icon>
);

export const SlidersIcon = (p) => (
  <Icon {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2.2" />
    <circle cx="10" cy="17" r="2.2" />
  </Icon>
);

export const CopyIcon = (p) => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.2" />
    <path d="M15.5 5.5A2 2 0 0 0 13.5 3.5h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2" />
  </Icon>
);

export const KeyboardIcon = (p) => (
  <Icon {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.2" />
    <path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6 13h.01M18 13h.01M9.5 13h5" />
    <path d="M8.5 15.5h7" />
  </Icon>
);

export const CommandIcon = (p) => (
  <Icon {...p}>
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z" />
  </Icon>
);

import React from 'react';

export function Icon({ name = 'clock', size = 20 }) {
  const paths = {
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    settings: <><path d="M9.5 3h5l.5 2.4 1.6.9 2.3-.8 2.5 4.3-1.8 1.6v1.8l1.8 1.6-2.5 4.3-2.3-.8-1.6.9-.5 2.4h-5l-.5-2.4-1.6-.9-2.3.8-2.5-4.3 1.8-1.6v-1.8L2.6 9.8l2.5-4.3 2.3.8L9 5.4Z" /><circle cx="12" cy="12.3" r="3" /></>,
    edit: <><path d="m16 3 5 5-11 11-5 1 1-5Z" /><path d="m14 5 5 5" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8V3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
    note: <><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9" /><path d="m16 3 5 5-9 9-5 1 1-5 8-10Z" /></>,
    music: <><path d="M9 18V5l12-2v13M9 9l12-2" /><ellipse cx="6" cy="18" rx="3" ry="3" /><ellipse cx="18" cy="16" rx="3" ry="3" /></>,
    play: <path d="m9 5 10 7-10 7Z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    previous: <><path d="M5 5v14m14-14-10 7 10 7Z" /></>,
    next: <><path d="M19 5v14M5 5l10 7-10 7Z" /></>,
    power: <><path d="M12 3v9M7 5.5a9 9 0 1 0 10 0" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

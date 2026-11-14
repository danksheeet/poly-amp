// Иконки 24×24: контурные, цвет берут из текста. Нарисованы для Poly Amp.
const P = {
  play: '<path d="M7.500 4.800v14.400a1 1 0 0 0 1.500.860l11.400-7.200a1 1 0 0 0 0-1.720L9 3.940a1 1 0 0 0-1.500.860z" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 3.500v11"/><path d="M7.500 10.500 12 15l4.500-4.500"/><path d="M4.500 15.500v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
  pause: '<rect x="6" y="4.500" width="4" height="15" rx="1.200" fill="currentColor" stroke="none"/><rect x="14" y="4.500" width="4" height="15" rx="1.200" fill="currentColor" stroke="none"/>',
  rewind: '<path d="M6 5v14"/><path d="M18.500 5.500v13a.8.8 0 0 1-1.250.660L8.800 12.660a.8.8 0 0 1 0-1.320l8.450-6.500a.8.8 0 0 1 1.250.660z" fill="currentColor" stroke="none"/>',
  skip: '<path d="M18 5v14"/><path d="M5.500 5.500v13a.8.8 0 0 0 1.250.660l8.450-6.500a.8.8 0 0 0 0-1.320L6.750 4.840a.8.8 0 0 0-1.250.660z" fill="currentColor" stroke="none"/>',
  loop: '<path d="M17 2.500l3 3-3 3"/><path d="M4 11.500v-1.500a4.500 4.500 0 0 1 4.500-4.500H20"/><path d="M7 21.500l-3-3 3-3"/><path d="M20 12.500V14a4.500 4.500 0 0 1-4.500 4.500H4"/>',
  metronome: '<path d="M9.200 3h5.600l4.200 17.200a.8.8 0 0 1-.780 1H5.780a.8.8 0 0 1-.780-1z"/><path d="M12 16l5.500-9"/><path d="M7.300 16h9.400"/>',
  countIn: '<circle cx="12" cy="13.500" r="7.500"/><path d="M12 9.500v4l2.700 1.800"/><path d="M9.500 2.500h5"/><path d="M19 5.500l1.500 1.500"/>',
  volume: '<path d="M4 9.500v5a1 1 0 0 0 1 1h3l4.500 3.800a.6.6 0 0 0 1-.460V5.160a.6.6 0 0 0-1-.460L8 8.500H5a1 1 0 0 0-1 1z"/><path d="M16.500 8.800a4.500 4.500 0 0 1 0 6.400"/><path d="M19.200 6.200a8.200 8.200 0 0 1 0 11.600"/>',
  volumeLow: '<path d="M4 9.500v5a1 1 0 0 0 1 1h3l4.500 3.800a.6.6 0 0 0 1-.460V5.160a.6.6 0 0 0-1-.460L8 8.500H5a1 1 0 0 0-1 1z"/><path d="M16.500 8.800a4.500 4.500 0 0 1 0 6.400"/>',
  volumeOff: '<path d="M4 9.500v5a1 1 0 0 0 1 1h3l4.500 3.800a.6.6 0 0 0 1-.460V5.160a.6.6 0 0 0-1-.460L8 8.500H5a1 1 0 0 0-1 1z"/><path d="M17 9.500l5 5M22 9.500l-5 5"/>',
  solo: '<path d="M4 15.500V12a8 8 0 0 1 16 0v3.500"/><rect x="3" y="14" width="4.500" height="7" rx="1.600"/><rect x="16.500" y="14" width="4.500" height="7" rx="1.600"/>',
  folder: '<path d="M3 7.500V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.500a2 2 0 0 0-2-2h-6.800L10.200 5H5a2 2 0 0 0-2 2z"/>',
  recent: '<path d="M3.500 12a8.500 8.500 0 1 0 2.500-6"/><path d="M3 3.500V8h4.500"/><path d="M12 7.500V12l3 2"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-8.500 8.500"/><path d="M18.500 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.500a2 2 0 0 1 2-2h4"/>',
  zoomIn: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="M20 20l-4.500-4.500"/><path d="M7.500 10.500h6M10.500 7.500v6"/>',
  zoomOut: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="M20 20l-4.500-4.500"/><path d="M7.500 10.500h6"/>',
  fretboard: '<rect x="2.500" y="7" width="19" height="10" rx="1.500"/><path d="M7.500 7v10M12 7v10M16.500 7v10"/><path d="M2.500 10.300h19M2.500 13.700h19" stroke-width="1"/><circle cx="9.750" cy="12" r="1.100" fill="currentColor" stroke="none"/>',
  listen: '<path d="M6.500 9.500a5.500 5.500 0 0 1 11 0c0 3.300-3.200 4.300-3.200 7.300a3.200 3.200 0 0 1-6.300.700"/><path d="M9.500 9.500a2.500 2.500 0 0 1 5 0c0 1.300-1.200 1.800-1.700 2.700"/>',
  guitar: '<path d="M13.800 10.200L20.500 3.500"/><path d="M18.500 1.500l4 4"/><path d="M10.700 8.700c-1.200 0-2.200.700-2.700 1.800-.4 1-1.300 1.600-2.400 1.700a3.300 3.300 0 0 0-2.900 3.400c0 2.900 2.400 5.300 5.300 5.300a3.300 3.300 0 0 0 3.400-2.900c.1-1.100.7-2 1.700-2.400 1.100-.5 1.800-1.500 1.800-2.700 0-2.300-1.900-4.200-4.200-4.200z"/><circle cx="9.500" cy="14.500" r="1.300"/>',
  wait: '<path d="M6.500 3h11M6.500 21h11"/><path d="M8 3v2.500c0 2 1.300 3.300 2.600 4.300L12 11l1.400-1.200C14.700 8.800 16 7.500 16 5.500V3"/><path d="M8 21v-2.500c0-2 1.300-3.300 2.600-4.300L12 13l1.400 1.200c1.300 1 2.600 2.300 2.600 4.300V21"/>',
  note: '<path d="M9 18V5.500l11-2.500v13"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="17.500" cy="16" r="2.500"/>',
  speed: '<path d="M3.600 18a9 9 0 1 1 16.800 0"/><path d="M12 14.500l4.200-4.700"/><circle cx="12" cy="14.500" r="1.200" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M6.500 9.500L12 15l5.500-5.500"/>',
  tracks: '<path d="M4 6h10M4 12h16M4 18h12"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/>',
  drums: '<ellipse cx="12" cy="9.500" rx="8" ry="3"/><path d="M4 9.500v6c0 1.700 3.600 3 8 3s8-1.300 8-3v-6"/><path d="M7.500 3l3.300 5M16.500 3l-3.300 5"/>',
  keys: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 19v-5M15 19v-5"/><path d="M7.500 5v9h3V5M13.500 5v9h3V5" fill="currentColor" stroke="none" opacity=".35"/>',
  bass: '<path d="M13.800 10.200L21 3"/><path d="M19 1l4 4" stroke-width="1.400"/><path d="M10.700 8.700c-1.200 0-2.200.700-2.700 1.800-.4 1-1.300 1.600-2.400 1.700a3.300 3.300 0 0 0-2.900 3.400c0 2.900 2.400 5.300 5.300 5.300a3.300 3.300 0 0 0 3.400-2.900c.1-1.100.7-2 1.700-2.400 1.100-.5 1.800-1.500 1.800-2.700 0-2.300-1.900-4.200-4.200-4.200z"/><path d="M7.500 16.500l3-3"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.500 11a6.500 6.500 0 0 0 13 0"/><path d="M12 17.500V21"/>',
  staff: '<path d="M3 6.500h18M3 9.500h18M3 12.500h18M3 15.500h18M3 18.500h18" stroke-width="1.100"/><ellipse cx="10" cy="15.500" rx="2.700" ry="2" fill="currentColor" stroke="none" transform="rotate(-20 10 15.500)"/><path d="M12.500 14.800V4.500"/>',
  library: '<path d="M4.500 4h3.500v16H4.500zM10 4h3.500v16H10z"/><path d="M15.600 5.200l3.400-.900 3.300 14.800-3.400.800z"/>',
  refresh: '<path d="M19.500 11A7.600 7.600 0 0 0 6 6.700L4.500 8.300"/><path d="M4.500 3.500v4.800h4.800"/><path d="M4.500 13A7.600 7.600 0 0 0 18 17.300l1.500-1.600"/><path d="M19.500 20.500v-4.800h-4.800"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16.500h4"/>',
  tab: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 12h8M8 15h8M8 18h8" stroke-width="1.100"/><circle cx="10.500" cy="12" r="1.100" fill="currentColor" stroke="none"/><circle cx="13.500" cy="15" r="1.100" fill="currentColor" stroke="none"/>',
  search: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="M20 20l-4.500-4.500"/>',
  strings: '<path d="M9 18V5.500l11-2.500v13"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="17.500" cy="16" r="2.500"/>',
};

/** SVG-иконка разметкой; cls — дополнительный класс. */
export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.note}</svg>`;
}

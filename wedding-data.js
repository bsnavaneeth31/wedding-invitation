// Personalize your invitation here. Couple names/dates also need updating
// directly in index.html (hero heading, header-place date, dialog copy, page title).
export const couple = {
  partnerOne: "Pallavi",
  partnerTwo: "Navaneeth",
  calendarProdId: "-//Pallavi and Navaneeth//Wedding Invitation//EN",
};

// Both events are at the same place, so the venue is shown once in the
// details dialog rather than repeated on every event card.
export const venue = {
  name: "Mandara Wedding And Events",
  address: "Devagere Village, Kumbalagodu Gollahalli, Kengeri Hobli, Bengaluru - 560 074  ",
  // Optional: paste a real Google Maps share link here for precision.
  // If left blank, a map link is auto-generated from name + address.
  mapUrl: "https://maps.app.goo.gl/rz9q2b2dMcxX6uDSA",
};

export const events = [
  {
    title: "The promise we keep", label: "Muhurtha",
    start: "2026-10-21T09:00:00+05:30", end: "2026-10-21T10:30:00+05:30",
    note: "Traditional finery, open hearts, and happy tears.",
  },
  {
    title: "A celebration to follow", label: "Reception",
    start: "2026-10-21T11:30:00+05:30", end: "2026-10-21T15:00:00+05:30",
    note: "Laughter, blessings, and celebration.",
  },
];

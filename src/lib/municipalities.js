'use strict';

// Municipalities shown in the property form. Contact channels change often, so
// we deliberately do not hard-code email addresses: users paste the billing
// dispute address from their own bill or the municipality's website.
const MUNICIPALITIES = [
  { id: 'johannesburg', name: 'City of Johannesburg', ombud: 'Office of the Ombudsman, City of Johannesburg' },
  { id: 'tshwane', name: 'City of Tshwane', ombud: null },
  { id: 'ekurhuleni', name: 'City of Ekurhuleni', ombud: null },
  { id: 'cape-town', name: 'City of Cape Town', ombud: 'Office of the Ombudsman, City of Cape Town' },
  { id: 'ethekwini', name: 'eThekwini Municipality', ombud: null },
  { id: 'nelson-mandela-bay', name: 'Nelson Mandela Bay Municipality', ombud: null },
  { id: 'buffalo-city', name: 'Buffalo City Metropolitan Municipality', ombud: null },
  { id: 'mangaung', name: 'Mangaung Metropolitan Municipality', ombud: null },
  { id: 'msunduzi', name: 'Msunduzi Local Municipality', ombud: null },
  { id: 'mbombela', name: 'City of Mbombela', ombud: null },
  { id: 'polokwane', name: 'Polokwane Municipality', ombud: null },
  { id: 'rustenburg', name: 'Rustenburg Local Municipality', ombud: null },
  { id: 'emfuleni', name: 'Emfuleni Local Municipality', ombud: null },
  { id: 'mogale-city', name: 'Mogale City Local Municipality', ombud: null },
  { id: 'stellenbosch', name: 'Stellenbosch Municipality', ombud: null },
  { id: 'george', name: 'George Municipality', ombud: null },
  { id: 'other', name: 'Other municipality', ombud: null },
];

function findMunicipality(idOrName) {
  return MUNICIPALITIES.find((m) => m.id === idOrName || m.name === idOrName) || null;
}

function municipalityName(property) {
  const m = findMunicipality(property.municipality);
  if (!m || m.id === 'other') return property.municipality && m === null ? property.municipality : 'the Municipality';
  return m.name;
}

module.exports = { MUNICIPALITIES, findMunicipality, municipalityName };

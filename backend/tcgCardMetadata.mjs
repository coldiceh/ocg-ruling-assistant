const SPELL_TRAP_PROPERTIES = Object.freeze({
  Field: 'field',
  'Quick-Play': 'quickplay',
  Continuous: 'continuous',
  Equip: 'equip',
  Ritual: 'ritual',
  Counter: 'counter',
  Normal: '',
  '': '',
});

// Translate only the official catalog's declared type enum. This supplies the
// existing description matcher; it does not select a card or interpret text.
export function tcgCardPropertyFields(card) {
  if (card.ruleSystem !== 'TCG'
    || !['spell', 'trap'].includes(String(card.cardType || card.type || '').toLowerCase())
    || !Object.hasOwn(SPELL_TRAP_PROPERTIES, card.spellTrapSubtype)) return {};
  return {property: SPELL_TRAP_PROPERTIES[card.spellTrapSubtype]};
}

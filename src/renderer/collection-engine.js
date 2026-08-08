/**
 * collection-engine.js
 * Analiza todos los juegos cargados y sugiere colecciones personalizadas
 * para EmulationStation usando regex por nombre de saga.
 *
 * No requiere API externa — todo es pattern-matching local.
 */

// ── Catálogo de sagas ────────────────────────────────────────────────────────
// Cada entrada: { id, label, emoji, patterns[] }
// patterns son RegExp aplicados contra game.name (case-insensitive)
const SAGA_CATALOG = [
  {
    id: 'double_dragon',
    label: 'Double Dragon',
    emoji: '🐉',
    description: 'Saga beat-em-up de Technos Japan (1987–)',
    patterns: [/double\s*dragon/i],
  },
  {
    id: 'street_fighter',
    label: 'Street Fighter',
    emoji: '🥊',
    description: 'Saga de lucha de Capcom (1987–)',
    patterns: [/street\s*fighter/i, /\bSF\s*[IVX\d]+/],
  },
  {
    id: 'mega_man',
    label: 'Mega Man',
    emoji: '🤖',
    description: 'Saga de acción-plataformas de Capcom (1987–)',
    patterns: [/mega\s*man/i, /megaman/i, /rockman/i],
  },
  {
    id: 'castlevania',
    label: 'Castlevania',
    emoji: '🏰',
    description: 'Saga de acción-aventura de Konami (1986–)',
    patterns: [/castlevania/i, /akumajo\s*dracula/i],
  },
  {
    id: 'contra',
    label: 'Contra',
    emoji: '🔫',
    description: 'Saga de run-and-gun de Konami (1987–)',
    patterns: [/\bcontra\b/i, /probotector/i, /gryzor/i],
  },
  {
    id: 'zelda',
    label: 'The Legend of Zelda',
    emoji: '🗡️',
    description: 'Saga de acción-aventura de Nintendo (1986–)',
    patterns: [/zelda/i],
  },
  {
    id: 'mario',
    label: 'Super Mario',
    emoji: '🍄',
    description: 'Saga de plataformas de Nintendo (1985–)',
    patterns: [/super\s*mario/i, /\bmario\s*bros/i, /\bmario\s*[123456]/i, /\byoshi/i],
  },
  {
    id: 'sonic',
    label: 'Sonic the Hedgehog',
    emoji: '💨',
    description: 'Saga de plataformas de Sega (1991–)',
    patterns: [/\bsonic\b/i],
  },
  {
    id: 'final_fight',
    label: 'Final Fight',
    emoji: '👊',
    description: 'Saga beat-em-up de Capcom (1989–)',
    patterns: [/final\s*fight/i],
  },
  {
    id: 'mortal_kombat',
    label: 'Mortal Kombat',
    emoji: '🩸',
    description: 'Saga de lucha de Midway/NetherRealm (1992–)',
    patterns: [/mortal\s*kombat/i, /\bMK\s*[IVX\d]+/i],
  },
  {
    id: 'streets_of_rage',
    label: 'Streets of Rage',
    emoji: '🏙️',
    description: 'Saga beat-em-up de Sega (1991–)',
    patterns: [/streets\s*of\s*rage/i, /bare\s*knuckle/i],
  },
  {
    id: 'golden_axe',
    label: 'Golden Axe',
    emoji: '🪓',
    description: 'Saga beat-em-up de Sega (1989–)',
    patterns: [/golden\s*axe/i],
  },
  {
    id: 'metroid',
    label: 'Metroid',
    emoji: '🌌',
    description: 'Saga de acción-aventura de Nintendo (1986–)',
    patterns: [/\bmetroid\b/i],
  },
  {
    id: 'donkey_kong',
    label: 'Donkey Kong',
    emoji: '🦍',
    description: 'Saga de plataformas de Nintendo (1981–)',
    patterns: [/donkey\s*kong/i],
  },
  {
    id: 'pac_man',
    label: 'Pac-Man',
    emoji: '🟡',
    description: 'Saga arcade de Namco (1980–)',
    patterns: [/pac[\s\-]?man/i, /pacman/i],
  },
  {
    id: 'kirby',
    label: 'Kirby',
    emoji: '⭐',
    description: 'Saga de plataformas de HAL Laboratory (1992–)',
    patterns: [/\bkirby\b/i],
  },
  {
    id: 'punch_out',
    label: 'Punch-Out!!',
    emoji: '🥊',
    description: 'Saga de boxeo de Nintendo (1983–)',
    patterns: [/punch[\s\-]?out/i],
  },
  {
    id: 'bomberman',
    label: 'Bomberman',
    emoji: '💣',
    description: 'Saga de acción de Hudson Soft (1983–)',
    patterns: [/bomberman/i, /dyna\s*blaster/i],
  },
  {
    id: 'teenage_mutant',
    label: 'TMNT',
    emoji: '🐢',
    description: 'Teenage Mutant Ninja Turtles (1989–)',
    patterns: [/teenage\s*mutant/i, /\btmnt\b/i, /ninja\s*turtles/i],
  },
  {
    id: 'battletoads',
    label: 'Battletoads',
    emoji: '🐸',
    description: 'Saga beat-em-up de Rare (1991–)',
    patterns: [/battletoads/i],
  },
  {
    id: 'king_of_fighters',
    label: 'King of Fighters',
    emoji: '👑',
    description: 'Saga de lucha de SNK (1994–)',
    patterns: [/king\s*of\s*fighters/i, /\bKOF\s*['`]?\d*/i],
  },
  {
    id: 'metal_slug',
    label: 'Metal Slug',
    emoji: '🪖',
    description: 'Saga run-and-gun de SNK (1996–)',
    patterns: [/metal\s*slug/i],
  },
  {
    id: 'fatal_fury',
    label: 'Fatal Fury',
    emoji: '💥',
    description: 'Saga de lucha de SNK (1991–)',
    patterns: [/fatal\s*fury/i, /garou\s*densetsu/i],
  },
  {
    id: 'samurai_shodown',
    label: 'Samurai Shodown',
    emoji: '⚔️',
    description: 'Saga de lucha de SNK (1993–)',
    patterns: [/samurai\s*sho(w|)down/i, /samurai\s*spirits/i],
  },
  {
    id: 'ghosts_goblins',
    label: "Ghosts 'n Goblins",
    emoji: '👻',
    description: 'Saga de acción de Capcom (1985–)',
    patterns: [/ghosts\s*['\u2019]?n\s*goblins/i, /ghouls\s*['\u2019]?n\s*ghosts/i, /super\s*ghouls/i],
  },
  {
    id: 'ninja_gaiden',
    label: 'Ninja Gaiden',
    emoji: '🥷',
    description: 'Saga de acción de Tecmo (1988–)',
    patterns: [/ninja\s*gaiden/i, /ninja\s*ryukenden/i],
  },
  {
    id: 'bionic_commando',
    label: 'Bionic Commando',
    emoji: '🦾',
    description: 'Saga de acción de Capcom (1987–)',
    patterns: [/bionic\s*commando/i],
  },
  {
    id: 'altered_beast',
    label: 'Altered Beast',
    emoji: '🐺',
    description: 'Saga beat-em-up de Sega (1988–)',
    patterns: [/altered\s*beast/i, /juuouki/i],
  },
  {
    id: 'shinobi',
    label: 'Shinobi',
    emoji: '🎴',
    description: 'Saga de acción de Sega (1987–)',
    patterns: [/\bshinobi\b/i, /revenge\s*of\s*shinobi/i, /shadow\s*dancer/i],
  },
  {
    id: 'r_type',
    label: 'R-Type',
    emoji: '🚀',
    description: 'Saga shoot-em-up de Irem (1987–)',
    patterns: [/\br[\-\s]?type\b/i],
  },
  {
    id: 'gradius',
    label: 'Gradius',
    emoji: '✈️',
    description: 'Saga shoot-em-up de Konami (1985–)',
    patterns: [/\bgradius\b/i, /\bnemesis\b/i, /\bsalamander\b/i],
  },
  {
    id: 'tetris',
    label: 'Tetris',
    emoji: '🧱',
    description: 'Saga de puzzle de Alexey Pajitnov (1984–)',
    patterns: [/\btetris\b/i],
  },
  {
    id: 'bomberman_quest',
    label: 'Adventure / RPG 16-bit',
    emoji: '🗺️',
    description: 'RPGs clásicos de 16 bits',
    patterns: [/final\s*fantasy/i, /\bchrono\b/i, /\bff\s*[IVX\d]+/i],
  },
];

// ── Análisis principal ───────────────────────────────────────────────────────

/**
 * Recibe un array plano de games (de todos los sistemas) y devuelve
 * sugerencias de colecciones con los juegos que pertenecen a cada saga.
 *
 * @param {Array<{name:string, path:string, system:string, ...}>} allGames
 * @returns {Array<{saga, matches}>}
 */
function analyzeSagas(allGames) {
  const suggestions = [];

  for (const saga of SAGA_CATALOG) {
    const matches = allGames.filter(game => {
      const title = game.name || game.path || '';
      return saga.patterns.some(rx => rx.test(title));
    });

    if (matches.length >= 2) {  // solo sugerir si hay al menos 2 juegos
      suggestions.push({
        saga: {
          id: saga.id,
          label: saga.label,
          emoji: saga.emoji,
          description: saga.description,
        },
        matches,
        count: matches.length,
      });
    }
  }

  // Ordenar por cantidad de juegos desc
  suggestions.sort((a, b) => b.count - a.count);
  return suggestions;
}

/**
 * Búsqueda libre: dado un término, sugiere qué juegos coinciden
 * usando fuzzy-regex (cada palabra como fragmento).
 */
function searchSaga(allGames, term) {
  const words = term.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const pattern = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');
  return allGames.filter(g => pattern.test(g.name || ''));
}

module.exports = { analyzeSagas, searchSaga, SAGA_CATALOG };

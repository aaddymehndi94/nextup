// Human wording for content features: row titles and reasons. Pure.

const PLURAL: Record<string, string> = {
  Action: 'Action',
  Adventure: 'Adventures',
  Animation: 'Animation',
  Biography: 'Biopics',
  Comedy: 'Comedies',
  Crime: 'Crime',
  Documentary: 'Documentaries',
  Drama: 'Dramas',
  Family: 'Family films',
  Fantasy: 'Fantasy',
  History: 'Historical dramas',
  Horror: 'Horror',
  Music: 'Music films',
  Musical: 'Musicals',
  Mystery: 'Mysteries',
  Romance: 'Romance',
  'Sci-Fi': 'Sci-Fi',
  Sport: 'Sports films',
  Thriller: 'Thrillers',
  War: 'War films',
  Western: 'Westerns',
  Animated: 'Animation',
}

/** Adjective form, used in front of another genre ("romantic dramas"). */
const ADJ: Record<string, string> = {
  Action: 'action',
  Adventure: 'adventure',
  Animation: 'animated',
  Biography: 'biographical',
  Comedy: 'comic',
  Crime: 'crime',
  Documentary: 'documentary',
  Drama: 'dramatic',
  Family: 'family',
  Fantasy: 'fantasy',
  History: 'historical',
  Horror: 'horror',
  Music: 'musical',
  Mystery: 'mystery',
  Romance: 'romantic',
  'Sci-Fi': 'sci-fi',
  Sport: 'sports',
  Thriller: 'thriller',
  War: 'war',
  Western: 'western',
}

/** Pairs that have a natural name. Key: genres sorted alphabetically, joined by '+'. */
const PAIRS: Record<string, string> = {
  'Comedy+Romance': 'Romantic comedies',
  'Drama+Romance': 'Romantic dramas',
  'Crime+Drama': 'Crime dramas',
  'Crime+Thriller': 'Crime thrillers',
  'Action+Sci-Fi': 'Sci-Fi action',
  'Drama+Sci-Fi': 'Thoughtful sci-fi',
  'Mystery+Sci-Fi': 'Sci-Fi mysteries',
  'Sci-Fi+Thriller': 'Sci-Fi thrillers',
  'Horror+Thriller': 'Horror thrillers',
  'Horror+Mystery': 'Horror mysteries',
  'Mystery+Thriller': 'Mystery thrillers',
  'Drama+Mystery': 'Mystery dramas',
  'Drama+Thriller': 'Dramatic thrillers',
  'Action+Thriller': 'Action thrillers',
  'Action+Crime': 'Crime action',
  'Action+Adventure': 'Action adventures',
  'Action+Comedy': 'Action comedies',
  'Comedy+Drama': 'Comedy-dramas',
  'Comedy+Crime': 'Crime comedies',
  'Comedy+Horror': 'Horror comedies',
  'Adventure+Fantasy': 'Fantasy adventures',
  'Adventure+Sci-Fi': 'Sci-Fi adventures',
  'Animation+Family': 'Family animation',
  'Animation+Comedy': 'Animated comedies',
  'Animation+Adventure': 'Animated adventures',
  'Drama+History': 'Historical dramas',
  'Drama+War': 'War dramas',
  'Biography+Drama': 'Biographical dramas',
  'Drama+Family': 'Family dramas',
  'Drama+Sport': 'Sports dramas',
  'Drama+Fantasy': 'Fantasy dramas',
  'Drama+Horror': 'Dramatic horror',
  'Fantasy+Romance': 'Fantasy romance',
  'Documentary+Music': 'Music documentaries',
  'Crime+Mystery': 'Crime mysteries',
}

export const genrePlural = (g: string): string => PLURAL[g] ?? g

export function pairLabel (a: string, b: string): string {
  const [x, y] = [a, b].sort()
  const named = PAIRS[`${x}+${y}`]
  if (named) return named
  // "Drama" reads best as the noun: "historical dramas".
  const [adj, noun] = y === 'Drama' || y === 'Comedy' || y === 'Thriller' ? [x, y] : [y, x]
  const plural = genrePlural(noun)
  return `${capitalise(ADJ[adj] ?? adj.toLowerCase())} ${plural === noun ? plural : plural.toLowerCase()}`
}

/** "1990s" → "’90s" for recent decades, "1960s" for older ones. */
export function decadeShort (decade: string): string {
  const d = Number.parseInt(decade, 10)
  return d >= 1970 && d < 2000 ? `${String(d).slice(2)}s` : decade
}

/** "Action" + "1980s" → "80s action". */
export function eraLabel (genre: string, decade: string): string {
  const plural = genrePlural(genre)
  return `${decadeShort(decade)} ${plural === 'Sci-Fi' ? plural : plural.toLowerCase()}`
}

export const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export const decadeOf = (year: number): string => `${Math.floor(year / 10) * 10}s`

/** Join names: "A", "A and B", "A, B and C". */
export function joinNames (names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

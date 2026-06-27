const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const SET = new Set(ALPHABET)

function isValidBase58(s) {
  if (typeof s !== 'string') return false
  for (let i = 0; i < s.length; i++) {
    if (!SET.has(s[i])) return false
  }
  return true
}

module.exports = { ALPHABET, isValidBase58 }

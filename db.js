const mongoose = require('mongoose')

async function connectDb() {
  const uri = process.env.MONGO_URI
  if (!uri) {
    throw new Error('MONGO_URI is not set. Refusing to start the database connection.')
  }
  await mongoose.connect(uri)
  mongoose.connection.on('error', err => console.error('[mongo] error', err))
  mongoose.connection.on('disconnected', () => console.warn('[mongo] disconnected'))
  console.log('[mongo] connected')
  return mongoose.connection
}

module.exports = { connectDb, mongoose }

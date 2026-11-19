import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { stdin, stdout } from 'node:process'

const iterations = 100_000

function readHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal.')
  }

  return new Promise((resolve, reject) => {
    let value = ''
    stdin.setEncoding('utf8')
    stdin.setRawMode(true)
    stdin.resume()
    stdout.write(prompt)

    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      stdout.write('\n')
    }

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('Password generation cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('')
          stdout.write('\b \b')
          continue
        }
        if (character >= ' ') {
          value += character
          stdout.write('*')
        }
      }
    }

    stdin.on('data', onData)
  })
}

try {
  const password = await readHidden('New admin password (minimum 12 characters): ')
  const confirmation = await readHidden('Confirm admin password: ')

  if (password.length < 12) {
    throw new Error('Use a password with at least 12 characters.')
  }
  if (password !== confirmation) {
    throw new Error('The passwords do not match.')
  }

  const salt = randomBytes(16)
  const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  stdout.write(`ADMIN_PASSWORD_HASH=pbkdf2_sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}\n`)
} catch (error) {
  stdout.write(`${error instanceof Error ? error.message : 'Unable to generate password hash.'}\n`)
  process.exitCode = 1
}

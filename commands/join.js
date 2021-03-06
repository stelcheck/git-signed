const cp = require('child_process')
const fs = require('fs')
const inquirer = require('inquirer')
const path = require('path')
const tempfile = require('tempfile')

const DEFAULT_GPG_KEY_SERVER = 'hkp://pool.sks-keyservers.net'

const pkgDataPath = path.join(process.cwd(), 'package.json')
const pkgData = require(pkgDataPath)

if (!pkgData.contributors) {
  pkgData.contributors = []
}

function getFromGitConfig(entryLabel) {
  const str = cp.execSync(`git config ${entryLabel}`).toString()

  return str.substring(str, str.length - 1)
}

function setToGitConfig(entryLabel, value) {
  cp.execSync(`git config ${entryLabel} ${value}`)
}

function listKeys() {
  const keys = []
  const out = cp.execSync(`gpg --list-secret-keys`)
  const keysList = out.toString().split('\n\n')
  let firstKey = true

  while (keysList.length) {
    const key = keysList.shift()
    let keyLines = key.split('\n')

    if (keyLines.length === 1) {
      continue
    }

    if (firstKey) {
      keyLines.shift()
      keyLines.shift()
      firstKey = false
    }

    const id = keyLines[1].trim()
    const userIds = keyLines
      .filter((val) => val.substring(0, 3) === 'uid')
      .map((val) => val.substring(3).trim())

    const info = {}
    const infoKeys = [
      'encryption',
      'creationDate',
      'flags',
      'expirationDate'
    ]

    keyLines[0]
      .substring(6)
      .split(' ')
      .forEach((val) => {
        if (val === '[expires:') {
          return
        }

        const key = infoKeys.shift()
        if (key === 'expirationDate') {
          info[key] = val.substring(0, val.length - 1)
        } else {
          info[key] = val
        }
      })

    if (!info.expirationDate) {
      info.expirationDate = 'never'
    }

    keys.push({ id, info, userIds })
  }

  return keys
}

async function retrieveInfo() {
  const defaultName = getFromGitConfig('user.name')
  const defaultEmail = getFromGitConfig('user.email')

  const { name, email } = await inquirer
    .prompt([{
      type: 'input',
      name: 'name',
      message: 'Enter your name',
      default: defaultName
    }, {
      type: 'input',
      name: 'email',
      message: 'Enter your email',
      default: defaultEmail
    }])

  const keys = listKeys()
  const keyId = await selectKey(name, email, keys)
  const keyServer = await selectPublicServer()
  const key = `${keyServer}#${keyId}`

  await pushToPublicServer(keyServer, keyId)
  configureLocalGitRepository(name, email, keyId)

  return { name, email, key }
}

async function createKey(name, email) {
  const { passphrase } = await inquirer.prompt([{
    type: 'password',
    name: 'passphrase',
    mask: '*',
    message: 'Enter a passphrase for your new key (or hit enter if you do not want to set one)'
  }])

  const setPassphrase = passphrase === '' ? '' : `Passphrase: ${passphrase}`
  const configFile = tempfile()

  fs.writeFileSync(configFile, `%no-ask-passphrase
%no-protection
Key-Type: default
Key-Length: 4096
Subkey-Type: 1
Subkey-Length: 4096
Name-Real: ${name}
Name-Email: ${email}
Expire-Date: 0
${setPassphrase}
%commit
`)

  cp.execSync('gpg --batch --gen-key ' + configFile)
  fs.unlinkSync(configFile)

  return selectKey(name, email, listKeys())
}

async function selectKey(name, email, keys) {
  const choices = keys.map(({ id, info: { creationDate, expirationDate, encryption }, userIds }) => {
    const stats = `Created ${creationDate} | Expires ${expirationDate}`
    const ids = userIds.reduce((txt, val) => txt + '\n    - ' + val, '')
    return {
      name: `${id} (${encryption}) [${stats}] ${ids}`,
      value: id
    }
  })

  choices.push({
    name: 'Create a new GPG key\n\tWe will help you create a new key without expiration date',
    value: false
  })

  const { keyId } = await inquirer.prompt([{
    type: 'list',
    name: 'keyId',
    message: 'Select the GPG key you wish to use for signing your commits',
    choices
  }])

  if (keyId === false) {
    return createKey(name, email)
  }

  return keyId
}

async function selectPublicServer() {
  const { keyServer } = await inquirer.prompt([{
    type: 'input',
    name: 'keyServer',
    message: 'Enter the server where you would like to export your public key',
    default: DEFAULT_GPG_KEY_SERVER
  }])

  return keyServer
}

async function pushToPublicServer(server, keyName) {
  console.log(`Sending your public key to ${server}...`)
  cp.execSync(`gpg --keyserver ${server} --send-key ${keyName}`)
}

function savePackageFile(contributorInfo) {
  const matchingContributor = pkgData.contributors
    .filter(({ email, name }) => contributorInfo.name === name && contributorInfo.email === email)

  if (matchingContributor.length > 0) {
    Object.assign(matchingContributor[0], contributorInfo)
  } else {
    pkgData.contributors.push(contributorInfo)
  }

  fs.writeFileSync(pkgDataPath, JSON.stringify(pkgData, null, 2))
}

function configureLocalGitRepository(user, email, keyId) {
  console.log(`Setting up the local git repository to auto-sign all commits...`)
  setToGitConfig(`user.name`, user)
  setToGitConfig(`user.email`, email)
  setToGitConfig(`user.signingkey`, keyId)
  setToGitConfig(`commit.gpgsign`, `true`)
}

retrieveInfo()
  .then(savePackageFile)
  .catch((error) => console.error(error) && process.exit(1))

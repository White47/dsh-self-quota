/**
 * 清单自检：确认这个组合包能被 DSH 正确识别与装载。
 * 依据：官方《打包与安装插件》文档 + 参考插件的真实 manifest。
 *
 * 运行：node scripts/selfcheck.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let failed = 0
const check = (label, ok, extra = '') => {
  if (ok) console.log(`  OK    ${label}${extra ? `  -> ${extra}` : ''}`)
  else { failed += 1; console.log(`  FAIL  ${label}${extra ? `  -> ${extra}` : ''}`) }
}

const patch = pkg.dsh?.bundle?.patch
const hostEntry = pkg.exports?.['.']
const clientEntry = pkg.exports?.['./client']

console.log('=== dsh.bundle（可安装单元的定义，缺了 dsh plugin add 不会挂载）===')
check('dsh.bundle.patch 已声明', typeof patch === 'string', patch)
check('patch 文件存在', typeof patch === 'string' && fs.existsSync(path.join(root, patch)), patch)
if (typeof patch === 'string' && fs.existsSync(path.join(root, patch))) {
  const yml = fs.readFileSync(path.join(root, patch), 'utf8')
  check('patch 按包名引用本包', yml.includes(pkg.name), `name: ${pkg.name}`)
  check('patch 含 insert 与 id', /insert:/.test(yml) && /id:/.test(yml))
}

console.log('\n=== 入口（host / client 半体）===')
check('exports["."] 已声明且文件存在', typeof hostEntry === 'string' && fs.existsSync(path.join(root, hostEntry)), hostEntry)
check('exports["./client"] 已声明且文件存在', typeof clientEntry === 'string' && fs.existsSync(path.join(root, clientEntry)), clientEntry)
check('host 入口导出了 apply 与 Config', (() => {
  const src = fs.readFileSync(path.join(root, hostEntry), 'utf8')
  return /export\s+function\s+apply/.test(src) && /export\s+const\s+Config/.test(src)
})())

console.log('\n=== dsh.client（浏览器半体声明）===')
check('platform = web', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client?.platform)
check('immediately = true', pkg.dsh?.client?.immediately === true)
check('inject 非空', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
  (pkg.dsh?.client?.inject ?? []).join(', '))

console.log('\n=== 分发（预构建，用户免构建授权）===')
check('files 覆盖 host / client / lib / patch', ['index.js', 'client.js', 'lib', 'cordis.patch.yml']
  .every(f => pkg.files?.includes(f)), (pkg.files ?? []).join(', '))
check('没有 build / prepare 脚本', !pkg.scripts?.build && !pkg.scripts?.prepare,
  'git 安装才需要 prepare；预构建分发不需要，用户也不必授权 allowBuilds')
check('声明了 license', !!pkg.license, pkg.license)
check('声明了 dsh-plugin 关键词', (pkg.keywords ?? []).includes('dsh-plugin'))

console.log('\n=== 供给客户端的服务是否都声明在 inject 里 ===')
const clientSrc = fs.readFileSync(path.join(root, clientEntry), 'utf8')
const injectMatch = clientSrc.match(/var\s+inject\s*=\s*\[([^\]]*)\]/)
const services = injectMatch ? injectMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean) : []
for (const svc of ['slots', 'connection', 'locale']) {
  check(`导出 inject 含 ${svc}`, services.includes(svc), services.join(', '))
}
for (const svc of services) {
  check(`代码里确实用到 ctx.${svc}`, clientSrc.includes(`ctx.${svc}`))
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)

# 把 @better-than-coca/dsh-session-handoff 复制进 desktop profile 的 node_modules（本地改源码调试用）。
# 必须是复制而不是 junction/link：Node 会解析真实路径，链接过去的目录
# 找不到 profile 里的 @deepseek-ai/* 宿主包。
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'lib'
$link = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@better-than-coca\dsh-session-handoff'
New-Item -ItemType Directory (Split-Path $link -Parent) -Force | Out-Null
if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        # 是 pnpm 建的链接：只删链接本身，绝不递归进目标目录
        cmd /c rmdir "$link"
    } else {
        Remove-Item $link -Recurse -Force
    }
}
# 目标目录必须先存在：Copy-Item -Recurse 到不存在的路径会把 lib 的内容
# 直接摊成包根（没有 lib/），包随即起不来。0.7.0 第一次安装就这么中过。
New-Item -ItemType Directory $link -Force | Out-Null
Copy-Item $src $link -Recurse
Copy-Item (Join-Path $PSScriptRoot 'LICENSE') $link
Copy-Item (Join-Path $PSScriptRoot 'README.md') $link
Copy-Item (Join-Path $PSScriptRoot 'client.js') $link
Copy-Item (Join-Path $PSScriptRoot 'package.json') $link
Copy-Item (Join-Path $PSScriptRoot 'cordis.patch.yml') $link
Write-Output ("installed -> " + $link)

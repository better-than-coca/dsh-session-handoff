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
Copy-Item $src $link -Recurse
Copy-Item (Join-Path $PSScriptRoot 'client.js') $link
Copy-Item (Join-Path $PSScriptRoot 'package.json') $link
Copy-Item (Join-Path $PSScriptRoot 'cordis.patch.yml') $link
Write-Output ("installed -> " + $link)

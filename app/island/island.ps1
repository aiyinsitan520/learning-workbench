# 贾维喵桌面灵动岛：屏幕顶部居中的黑色胶囊，无标题栏、总在最前，悬停弹性展开。
# 纯 Windows 自带 WPF 实现，不用安装任何东西；数据走本机学习工作台接口（默认 127.0.0.1:7321）。
# 外观与交互参考 AsamiAkito/wisland（MIT，Windows 灵动岛：贴边胶囊、悬停弹性展开、拖动）
# 与 Apple 灵动岛（黑色胶囊、计时用橙色）；DynamicWin 等 WPF 灵动岛同样是无边框透明置顶窗口的做法。
# 由学习工作台的「桌面灵动岛」按钮（POST /api/island）启动，也可以直接运行本脚本。
param(
  [int]$Port = 7321,
  [switch]$Demo,      # 演示：不连接口，固定显示一组示例数据（截图、调样式用）
  [switch]$Expanded   # 演示：一打开就是展开态，且不自动收起
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

# 出错时写日志（app/data/island.log，不入库），方便排查「点了没反应」
$logFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\data\island.log'
trap {
  try { Add-Content -Encoding utf8 -Path $logFile -Value ("{0} {1}`n{2}" -f (Get-Date -Format s), $_.Exception.Message, $_.ScriptStackTrace) } catch {}
  exit 1
}

# 单实例：已经开着就自己退出。上一个实例被强制结束时互斥量处于「被遗弃」状态，
# 这时 WaitOne 会抛 AbandonedMutexException，但锁其实已经拿到，照常继续。
$mutex = New-Object System.Threading.Mutex($false, 'Global\LearningWorkbenchIsland')
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { exit 0 }

$base = "http://127.0.0.1:$Port"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$avatar = Join-Path $here '..\..\kitten.png'

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="贾维喵灵动岛" Width="440" Height="190" WindowStyle="None" AllowsTransparency="True"
        Background="{x:Null}" Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        FontFamily="Microsoft YaHei UI" UseLayoutRounding="True" SnapsToDevicePixels="True">
  <Window.Resources>
    <Style x:Key="Pill" TargetType="Button">
      <Setter Property="Foreground" Value="#FFFFFFFF"/>
      <Setter Property="Background" Value="#26FFFFFF"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="Height" Value="30"/>
      <Setter Property="Margin" Value="0,0,8,0"/>
      <Setter Property="Padding" Value="14,0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="15" Background="{TemplateBinding Background}" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.82"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.6"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid Background="{x:Null}">
    <Border x:Name="Island" Width="236" Height="38" CornerRadius="19" Background="#F2050507"
            HorizontalAlignment="Center" VerticalAlignment="Top" Margin="0,8,0,0" ClipToBounds="True" Cursor="SizeAll">
      <Border.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="3" Opacity="0.35" Color="#000000"/></Border.Effect>
      <Grid>
        <!-- 收起态：头像+进度环 · 任务名 · 倒计时 -->
        <Grid x:Name="Compact" Margin="6,0,14,0" VerticalAlignment="Center" Height="38">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="30"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <Grid Width="28" Height="28" VerticalAlignment="Center">
            <Ellipse x:Name="CAvatar" Width="22" Height="22"/>
            <Ellipse Width="28" Height="28" Stroke="#33FFFFFF" StrokeThickness="2.2"/>
            <Path x:Name="CRing" Stroke="#FFFF9F0A" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
          </Grid>
          <TextBlock x:Name="CTitle" Grid.Column="1" Margin="8,0,8,0" Foreground="#E6FFFFFF" FontSize="12.5"
                     VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
          <TextBlock x:Name="CTime" Grid.Column="2" Foreground="#FFFF9F0A" FontSize="15" FontWeight="SemiBold"
                     FontFamily="Segoe UI Variable Display, Segoe UI" VerticalAlignment="Center"/>
        </Grid>
        <!-- 展开态 -->
        <Grid x:Name="Expanded" Margin="18,14,18,14" Opacity="0" IsHitTestVisible="False">
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/>
          </Grid.RowDefinitions>
          <DockPanel>
            <Ellipse x:Name="EAvatar" Width="30" Height="30" Margin="0,0,10,0" DockPanel.Dock="Left"/>
            <TextBlock x:Name="EStatus" DockPanel.Dock="Right" Foreground="#99FFFFFF" FontSize="11.5" VerticalAlignment="Center"/>
            <TextBlock x:Name="ETitle" Foreground="#FFFFFFFF" FontSize="14.5" FontWeight="SemiBold" VerticalAlignment="Center"
                       TextTrimming="CharacterEllipsis" Margin="0,0,10,0"/>
          </DockPanel>
          <TextBlock x:Name="ETime" Grid.Row="1" Foreground="#FFFF9F0A" FontSize="40" FontWeight="SemiBold" Margin="0,4,0,0"
                     FontFamily="Segoe UI Variable Display, Segoe UI"/>
          <Grid Grid.Row="2" Height="5" Margin="0,2,0,12">
            <Border CornerRadius="2.5" Background="#26FFFFFF"/>
            <Border x:Name="EBar" CornerRadius="2.5" Background="#FFFF9F0A" HorizontalAlignment="Left" Width="0"/>
          </Grid>
          <StackPanel Grid.Row="3" Orientation="Horizontal" VerticalAlignment="Bottom">
            <Button x:Name="BtnToggle" Style="{StaticResource Pill}" Background="#FFFF9F0A" Foreground="#FF1C1206" FontWeight="SemiBold" Content="开始"/>
            <Button x:Name="BtnFinish" Style="{StaticResource Pill}" Content="结束"/>
            <Button x:Name="BtnDone" Style="{StaticResource Pill}" Content="完成任务"/>
            <Button x:Name="BtnOpen" Style="{StaticResource Pill}" Content="工作台"/>
          </StackPanel>
        </Grid>
      </Grid>
    </Border>
  </Grid>
</Window>
"@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$el = @{}
foreach ($n in 'Island','Compact','Expanded','CAvatar','CRing','CTitle','CTime','EAvatar','EStatus','ETitle','ETime','EBar','BtnToggle','BtnFinish','BtnDone','BtnOpen') { $el[$n] = $win.FindName($n) }

if (Test-Path $avatar) {
  $img = New-Object Windows.Media.Imaging.BitmapImage([Uri](Resolve-Path $avatar).Path)
  foreach ($e in $el.CAvatar, $el.EAvatar) { $e.Fill = New-Object Windows.Media.ImageBrush($img) -Property @{ Stretch = 'UniformToFill' } }
} else {
  $fill = (New-Object Windows.Media.BrushConverter).ConvertFromString('#FFFF9F0A')
  foreach ($e in $el.CAvatar, $el.EAvatar) { $e.Fill = $fill }
}

# 放在主屏幕顶部居中。屏幕缩放（如 150%）下 WPF 用的是逻辑单位，必须用窗口实际的
# 设备→逻辑变换把屏幕像素换算过来，否则会偏到右边。
function Place-TopCenter {
  $src = [Windows.PresentationSource]::FromVisual($win)
  $m = $src.CompositionTarget.TransformFromDevice
  $px = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $tl = $m.Transform((New-Object Windows.Point $px.Left, $px.Top))
  $br = $m.Transform((New-Object Windows.Point $px.Right, $px.Bottom))
  $win.Left = $tl.X + ($br.X - $tl.X - $win.Width) / 2
  $win.Top = $tl.Y
}
$win.Add_SourceInitialized({ Place-TopCenter })

# ---------------------------------------------------------------- 数据
$state = @{ view = $null; recommended = $null; offset = 0; error = ''; busy = $false; expanded = $false }

function Get-Json($path) { Invoke-RestMethod -Uri ($base + $path) -TimeoutSec 2 }
function Send-Command($cmd) {
  $body = [Text.Encoding]::UTF8.GetBytes((@{ command = $cmd } | ConvertTo-Json -Depth 5 -Compress))
  Invoke-RestMethod -Method Post -Uri ($base + '/api/command') -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 4 | Out-Null
}
function Now-Server { [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $state.offset }

function Find-Title($id) {
  if (-not $id) { return '自由专注' }
  $v = $state.view
  foreach ($list in $v.pending, $v.completedOnDay) { foreach ($t in $list) { if ($t.id -eq $id) { return $t.title } } }
  foreach ($b in $v.scheduled) { if ($b.taskId -eq $id) { return $b.task.title } }
  return '专注中'
}

function Refresh-Data {
  if ($Demo) { return }
  try {
    if (-not $state.synced) { $h = Get-Json '/api/health'; $state.offset = [int]$h.now - [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $state.synced = $true }
    $p = Get-Json '/api/view'
    $state.view = $p.view; $state.recommended = $p.recommended; $state.error = ''
  } catch { $state.error = '学习工作台没有运行' }
}

# 当前该显示什么：返回 @{ title; status; left; planned; progress; open; taskId }
function Get-Snapshot {
  if ($Demo) { return @{ title = '整理电路实验数据'; status = '专注中'; left = 1122; planned = 1500; progress = 0.25; open = @{ state = 'running' }; taskId = 'demo' } }
  if ($state.error) { return @{ title = $state.error; status = '离线'; left = $null; planned = 1500; progress = 0; open = $null; taskId = $null } }
  $open = $state.view.openFocus
  if ($open) {
    $left = if ($open.state -eq 'running') { [int]$open.startedAt + [int]$open.plannedSeconds - [int]$open.elapsedSeconds - (Now-Server) } else { [int]$open.plannedSeconds - [int]$open.elapsedSeconds }
    $left = [Math]::Max(0, $left)
    return @{ title = (Find-Title $open.taskId); status = $(if ($open.state -eq 'running') { '专注中' } else { '已暂停' });
      left = $left; planned = [int]$open.plannedSeconds; progress = 1 - $left / [double]$open.plannedSeconds; open = $open; taskId = $open.taskId }
  }
  $rec = $state.recommended
  return @{ title = $(if ($rec) { $rec.title } else { '贾维喵 · 待专注' }); status = '待专注'; left = $null; planned = 1500; progress = 0; open = $null; taskId = $rec.id }
}

function Format-Clock($s) { if ($null -eq $s) { return '' } ; '{0:00}:{1:00}' -f [Math]::Floor($s / 60), ($s % 60) }

# ---------------------------------------------------------------- 绘制
$orange = [Windows.Media.Color]::FromArgb(255, 255, 159, 10)
$gray = [Windows.Media.Color]::FromArgb(255, 142, 142, 147)
function Set-Ring($p, $color) {
  # 28px 圆环上从 12 点钟方向顺时针画进度
  $p = [Math]::Min(0.9999, [Math]::Max(0, $p))
  if ($p -le 0) { $el.CRing.Data = $null; return }
  $r = 12.9; $c = 14; $a = 2 * [Math]::PI * $p - [Math]::PI / 2
  $x = $c + $r * [Math]::Cos($a); $y = $c + $r * [Math]::Sin($a)
  $large = if ($p -gt 0.5) { 1 } else { 0 }
  $el.CRing.Data = [Windows.Media.Geometry]::Parse(("M {0},{1} A {2},{2} 0 {3} 1 {4},{5}" -f $c, ($c - $r), $r, $large, $x.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture), $y.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)))
  $el.CRing.Stroke = New-Object Windows.Media.SolidColorBrush($color)
}

function Render {
  $s = Get-Snapshot
  $paused = $s.open -and $s.open.state -eq 'paused'
  $color = if ($paused) { $gray } else { $orange }
  $brush = New-Object Windows.Media.SolidColorBrush($color)
  $el.CTitle.Text = $s.title
  # 没有专注时右侧显示灰色「待专注」，有专注时显示倒计时
  if ($null -ne $s.left) { $el.CTime.Text = Format-Clock $s.left; $el.CTime.FontSize = 15; $el.CTime.Foreground = $brush }
  else { $el.CTime.Text = $s.status; $el.CTime.FontSize = 12; $el.CTime.Foreground = New-Object Windows.Media.SolidColorBrush($gray) }
  Set-Ring $s.progress $color
  $el.ETitle.Text = $s.title
  $el.EStatus.Text = $s.status
  $el.ETime.Text = $(if ($null -ne $s.left) { Format-Clock $s.left } else { Format-Clock $s.planned })
  $el.ETime.Foreground = $brush
  $el.EBar.Width = [Math]::Max(0, (440 - 36 - 36) * $s.progress)
  $el.EBar.Background = $brush
  $el.BtnToggle.Content = $(if (-not $s.open) { '开始 25 分钟' } elseif ($s.open.state -eq 'running') { '暂停' } else { '继续' })
  $el.BtnToggle.IsEnabled = [bool](-not $state.error -and ($s.open -or $s.taskId))
  $el.BtnFinish.Visibility = $(if ($s.open) { 'Visible' } else { 'Collapsed' })
  $el.BtnDone.Visibility = $(if ($s.taskId -and -not $state.error) { 'Visible' } else { 'Collapsed' })
}

# ---------------------------------------------------------------- 弹性展开 / 收起（参考 Wisland：展开约 420ms，带回弹）
function Animate($target, [double]$to, [int]$ms, [double]$amp) {
  $anim = New-Object Windows.Media.Animation.DoubleAnimation($to, [TimeSpan]::FromMilliseconds($ms))
  $ease = New-Object Windows.Media.Animation.BackEase; $ease.Amplitude = $amp; $ease.EasingMode = 'EaseOut'
  $anim.EasingFunction = $ease
  return $anim
}
function Set-Expanded([bool]$on) {
  if ($state.expanded -eq $on) { return }
  $state.expanded = $on
  $w = if ($on) { 404 } else { 236 }; $h = if ($on) { 158 } else { 38 }; $r = if ($on) { 30 } else { 19 }
  $el.Island.BeginAnimation([Windows.FrameworkElement]::WidthProperty, (Animate $null $w 420 0.32))
  $el.Island.BeginAnimation([Windows.FrameworkElement]::HeightProperty, (Animate $null $h 420 0.32))
  $el.Island.CornerRadius = New-Object Windows.CornerRadius($r)
  $fadeIn = New-Object Windows.Media.Animation.DoubleAnimation($(if ($on) { 1 } else { 0 }), [TimeSpan]::FromMilliseconds($(if ($on) { 260 } else { 120 })))
  if ($on) { $fadeIn.BeginTime = [TimeSpan]::FromMilliseconds(140) }
  $fadeOut = New-Object Windows.Media.Animation.DoubleAnimation($(if ($on) { 0 } else { 1 }), [TimeSpan]::FromMilliseconds(160))
  if (-not $on) { $fadeOut.BeginTime = [TimeSpan]::FromMilliseconds(180) }
  $el.Expanded.BeginAnimation([Windows.UIElement]::OpacityProperty, $fadeIn)
  $el.Compact.BeginAnimation([Windows.UIElement]::OpacityProperty, $fadeOut)
  $el.Expanded.IsHitTestVisible = $on
}

$collapseTimer = New-Object Windows.Threading.DispatcherTimer
$collapseTimer.Interval = [TimeSpan]::FromMilliseconds(650)
$collapseTimer.Add_Tick({ $collapseTimer.Stop(); Set-Expanded $false })
$el.Island.Add_MouseEnter({ $collapseTimer.Stop(); Set-Expanded $true })
$el.Island.Add_MouseLeave({ if (-not $Expanded) { $collapseTimer.Start() } })

# 拖动：按住岛身任意空白处
$el.Island.Add_MouseLeftButtonDown({ param($s, $e) if ($e.OriginalSource -isnot [Windows.Controls.Button]) { try { $win.DragMove() } catch {} } })

# ---------------------------------------------------------------- 按钮
function Do-Action([scriptblock]$fn) {
  if ($state.busy -or $Demo) { return }
  $state.busy = $true
  try { & $fn; Refresh-Data } catch { $state.error = '操作失败：' + $_.Exception.Message } finally { $state.busy = $false; Render }
}
$el.BtnToggle.Add_Click({
  Do-Action {
    $open = $state.view.openFocus
    if (-not $open) {
      $taskId = $state.recommended.id
      Send-Command @{ type = 'startFocus'; id = 'focus-' + [guid]::NewGuid().ToString(); taskId = $taskId; plannedSeconds = 1500 }
    } else {
      Send-Command @{ type = 'changeFocus'; id = $open.id; expectedRevision = [int]$open.revision; action = $(if ($open.state -eq 'running') { 'pause' } else { 'resume' }) }
    }
  }
})
$el.BtnFinish.Add_Click({
  Do-Action { $open = $state.view.openFocus; if ($open) { Send-Command @{ type = 'changeFocus'; id = $open.id; expectedRevision = [int]$open.revision; action = 'finish' } } }
})
$el.BtnDone.Add_Click({
  Do-Action {
    $s = Get-Snapshot
    $open = $state.view.openFocus
    if ($open) { Send-Command @{ type = 'changeFocus'; id = $open.id; expectedRevision = [int]$open.revision; action = 'finish' } }
    if ($s.taskId) { Send-Command @{ type = 'setTaskCompleted'; taskId = $s.taskId; completed = $true } }
  }
})
$el.BtnOpen.Add_Click({ Start-Process "$base/" })

# 右键菜单：打开工作台 / 关闭灵动岛
$menu = New-Object Windows.Controls.ContextMenu
foreach ($pair in @(@('打开学习工作台', { Start-Process "$base/" }), @('关闭灵动岛', { $win.Close() }))) {
  $mi = New-Object Windows.Controls.MenuItem; $mi.Header = $pair[0]; $mi.Add_Click($pair[1]); [void]$menu.Items.Add($mi)
}
$el.Island.ContextMenu = $menu

# ---------------------------------------------------------------- 定时器：1 秒取数据，250ms 刷新倒计时
$dataTimer = New-Object Windows.Threading.DispatcherTimer
$dataTimer.Interval = [TimeSpan]::FromSeconds(1)
$dataTimer.Add_Tick({ if (-not $state.busy) { Refresh-Data } })
$drawTimer = New-Object Windows.Threading.DispatcherTimer
$drawTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$drawTimer.Add_Tick({ Render })

$win.Add_Closed({ $dataTimer.Stop(); $drawTimer.Stop(); try { $mutex.ReleaseMutex() } catch {} })
Refresh-Data
Render
if ($Expanded) { $win.Add_ContentRendered({ Set-Expanded $true }) }
$dataTimer.Start(); $drawTimer.Start()
[void]$win.ShowDialog()

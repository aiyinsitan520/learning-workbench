# 贾维喵桌面灵动岛：屏幕顶部居中的黑色胶囊，无标题栏、总在最前，悬停弹性展开成 Wisland 式磨砂面板。
# 纯 Windows 自带 WPF 实现，不用安装任何东西；数据走本机学习工作台接口（默认 127.0.0.1:7321）。
# 外观与交互参考 AsamiAkito/wisland（MIT，Windows 灵动岛：贴边胶囊、悬停弹性展开、拖动；展开面板的
# 天蓝→米白磨砂底、眉眼腮红表情、白色胶囊页签、图标+文字快捷操作都照它的主页做）与 Apple 灵动岛（收起态黑色胶囊、计时橙）；DynamicWin 等 WPF 灵动岛同样是无边框透明置顶窗口的做法。
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
        Title="贾维喵灵动岛" Width="680" Height="300" WindowStyle="None" AllowsTransparency="True"
        Background="{x:Null}" Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        FontFamily="Microsoft YaHei UI" UseLayoutRounding="True" SnapsToDevicePixels="True">
  <Window.Resources>
    <!-- 展开面板的配色取自 Wisland 主页：天蓝→米白的磨砂底、深藏青文字、白色半透明胶囊 -->
    <SolidColorBrush x:Key="Ink" Color="#FF1B2A40"/>
    <SolidColorBrush x:Key="Ink2" Color="#B31B2A40"/>
    <Style x:Key="Round" TargetType="Button">
      <Setter Property="Foreground" Value="{StaticResource Ink}"/>
      <Setter Property="Background" Value="#80FFFFFF"/>
      <Setter Property="FontFamily" Value="Segoe Fluent Icons, Segoe MDL2 Assets"/>
      <Setter Property="FontSize" Value="15"/>
      <Setter Property="Width" Value="38"/>
      <Setter Property="Height" Value="38"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="99" Background="{TemplateBinding Background}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Background" Value="#CCFFFFFF"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.7"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.35"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Quick" TargetType="Button">
      <Setter Property="Foreground" Value="{StaticResource Ink}"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Margin" Value="2"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="14" Background="{TemplateBinding Background}" Padding="6,8">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Background" Value="#4DFFFFFF"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.7"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid Background="{x:Null}">
    <Grid x:Name="Island" Width="236" Height="38" HorizontalAlignment="Center" VerticalAlignment="Top" Margin="0,8,0,0" Cursor="SizeAll">
      <Grid.Effect><DropShadowEffect BlurRadius="22" ShadowDepth="4" Opacity="0.28" Color="#0B1A30"/></Grid.Effect>
      <!-- 两层底：收起时黑色胶囊，展开时 Wisland 式磨砂渐变，交叉淡入 -->
      <Border x:Name="DarkBg" CornerRadius="19" Background="#F2050507"/>
      <Border x:Name="GlassBg" CornerRadius="19" Opacity="0" BorderThickness="1" BorderBrush="#66FFFFFF">
        <Border.Background>
          <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
            <GradientStop Color="#FF5DB0EE" Offset="0"/>
            <GradientStop Color="#FF9CC6E6" Offset="0.32"/>
            <GradientStop Color="#FFD3E0E6" Offset="0.62"/>
            <GradientStop Color="#FFF4EBDF" Offset="1"/>
          </LinearGradientBrush>
        </Border.Background>
      </Border>
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
      <!-- 展开态：左 专注卡 · 中 表情 · 右 快捷操作（布局参考 Wisland 主页） -->
      <Grid x:Name="Expanded" Margin="24,16,22,18" Opacity="0" IsHitTestVisible="False">
        <Grid.RowDefinitions><RowDefinition Height="40"/><RowDefinition Height="*"/></Grid.RowDefinitions>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="236"/><ColumnDefinition Width="*"/><ColumnDefinition Width="168"/>
        </Grid.ColumnDefinitions>
        <!-- 顶部：选中的胶囊页签 -->
        <StackPanel Grid.ColumnSpan="3" Orientation="Horizontal" VerticalAlignment="Center">
          <Border CornerRadius="18" Background="#B3FFFFFF" Padding="14,6">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="&#xE916;" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="14" Foreground="{StaticResource Ink}" VerticalAlignment="Center" Margin="0,0,7,0"/>
              <TextBlock Text="专注" FontSize="13.5" FontWeight="SemiBold" Foreground="{StaticResource Ink}" VerticalAlignment="Center"/>
            </StackPanel>
          </Border>
          <TextBlock x:Name="ETab" Margin="16,0,0,0" FontSize="12.5" Foreground="{StaticResource Ink2}" VerticalAlignment="Center"/>
        </StackPanel>
        <!-- 左：专注卡 -->
        <StackPanel Grid.Row="1" VerticalAlignment="Center">
          <StackPanel Orientation="Horizontal">
            <Border Width="54" Height="54" CornerRadius="16" Background="#73FFFFFF">
              <Ellipse x:Name="EAvatar" Width="38" Height="38"/>
            </Border>
            <StackPanel Margin="12,0,0,0" VerticalAlignment="Center" Width="160">
              <TextBlock x:Name="ETitle" FontSize="15" FontWeight="Bold" Foreground="{StaticResource Ink}" TextTrimming="CharacterEllipsis"/>
              <TextBlock x:Name="EStatus" FontSize="12" Foreground="{StaticResource Ink2}" Margin="0,2,0,0"/>
            </StackPanel>
          </StackPanel>
          <TextBlock x:Name="ETime" FontSize="34" FontWeight="SemiBold" Foreground="{StaticResource Ink}" Margin="2,8,0,4"
                     FontFamily="Segoe UI Variable Display, Segoe UI"/>
          <Grid Width="214" Height="5" HorizontalAlignment="Left">
            <Border CornerRadius="2.5" Background="#59FFFFFF"/>
            <Border x:Name="EBar" CornerRadius="2.5" Background="#FF33496B" HorizontalAlignment="Left" Width="0"/>
          </Grid>
          <StackPanel Orientation="Horizontal" Margin="0,12,0,0" HorizontalAlignment="Left">
            <Button x:Name="BtnFinish" Style="{StaticResource Round}" Content="&#xE71A;" ToolTip="结束本轮并记录"/>
            <Button x:Name="BtnToggle" Style="{StaticResource Round}" Width="50" Height="50" FontSize="20" Margin="14,0" Background="#B3FFFFFF" Content="&#xE768;"/>
            <Button x:Name="BtnDone" Style="{StaticResource Round}" Content="&#xE8FB;" ToolTip="完成任务"/>
          </StackPanel>
        </StackPanel>
        <!-- 中：表情（眉眼、腮红、微笑；专注时轻轻呼吸，暂停时嘴角放平） -->
        <Canvas x:Name="Face" Grid.Row="1" Grid.Column="1" Width="170" Height="96" HorizontalAlignment="Center" VerticalAlignment="Center">
          <Canvas.RenderTransform><TranslateTransform x:Name="FaceShift" Y="0"/></Canvas.RenderTransform>
          <Path Data="M 24,34 Q 40,24 58,33" Stroke="{StaticResource Ink}" StrokeThickness="11" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
          <Path Data="M 112,33 Q 130,24 146,34" Stroke="{StaticResource Ink}" StrokeThickness="11" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
          <Ellipse Canvas.Left="10" Canvas.Top="54" Width="32" Height="15" Fill="#E6F2A6B8"/>
          <Ellipse Canvas.Left="128" Canvas.Top="54" Width="32" Height="15" Fill="#E6F2A6B8"/>
          <Path x:Name="Mouth" Data="M 72,60 Q 85,72 98,60" Stroke="{StaticResource Ink}" StrokeThickness="6" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
        </Canvas>
        <!-- 右：快捷操作（图标 + 文字，2×2） -->
        <UniformGrid Grid.Row="1" Grid.Column="2" Rows="2" Columns="2" VerticalAlignment="Center">
          <Button x:Name="QOpen" Style="{StaticResource Quick}">
            <StackPanel><TextBlock Text="&#xE80F;" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="20" HorizontalAlignment="Center"/>
              <TextBlock Text="工作台" FontSize="12.5" Margin="0,5,0,0" HorizontalAlignment="Center"/></StackPanel>
          </Button>
          <Button x:Name="QPin" Style="{StaticResource Quick}">
            <StackPanel><TextBlock x:Name="QPinIcon" Text="&#xE718;" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="20" HorizontalAlignment="Center"/>
              <TextBlock x:Name="QPinText" Text="固定展开" FontSize="12.5" Margin="0,5,0,0" HorizontalAlignment="Center"/></StackPanel>
          </Button>
          <Button x:Name="QFold" Style="{StaticResource Quick}">
            <StackPanel><TextBlock Text="&#xE70E;" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="20" HorizontalAlignment="Center"/>
              <TextBlock Text="收起" FontSize="12.5" Margin="0,5,0,0" HorizontalAlignment="Center"/></StackPanel>
          </Button>
          <Button x:Name="QClose" Style="{StaticResource Quick}">
            <StackPanel><TextBlock Text="&#xE711;" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="20" HorizontalAlignment="Center"/>
              <TextBlock Text="关闭" FontSize="12.5" Margin="0,5,0,0" HorizontalAlignment="Center"/></StackPanel>
          </Button>
        </UniformGrid>
      </Grid>
    </Grid>
  </Grid>
</Window>
"@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$el = @{}
foreach ($n in 'Island','DarkBg','GlassBg','Compact','Expanded','CAvatar','CRing','CTitle','CTime','ETab','EAvatar','EStatus','ETitle','ETime','EBar','BtnToggle','BtnFinish','BtnDone','Face','FaceShift','Mouth','QOpen','QPin','QPinIcon','QPinText','QFold','QClose') { $el[$n] = $win.FindName($n) }

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
$state = @{ view = $null; recommended = $null; plan = $null; offset = 0; error = ''; busy = $false; expanded = $false; pinned = $false; breathing = $false }

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
    $state.view = $p.view; $state.recommended = $p.recommended; $state.plan = $p.plan; $state.error = ''
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
  # 空闲：跟随日计划。正处在时间块里 → 时长 = 到块结束还剩的时间；块还没开始 → 时长 = 块的计划时长（口径同 app/public/js/plan-now.js）
  $plan = $state.plan
  if ($plan) {
    $secs = if ($plan.phase -eq 'now') { [int]$plan.endsAt - (Now-Server) } else { [int]$plan.seconds }
    if ($secs -ge 60) {
      $status = if ($plan.phase -eq 'now') { "到 $($plan.end)" } else { "$($plan.start) 开始" }
      return @{ title = $plan.title; status = $status; left = $null; planned = $secs; progress = 0; open = $null; taskId = $plan.taskId; plan = $plan }
    }
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
  $el.EStatus.Text = $(if ($s.open) { "$($s.status) · 计划 $([Math]::Round($s.planned / 60)) 分钟" }
    elseif ($s.plan) { "日计划 $($s.plan.start)–$($s.plan.end) · $([Math]::Ceiling($s.planned / 60)) 分钟" } else { $s.status })
  # 日期按工作台的北京时间（view.day），不用本机时区；演示 / 离线时才退回本机日期
  $d = if ($state.view.day) { [datetime]::ParseExact($state.view.day, 'yyyy-MM-dd', $null) } else { Get-Date }
  $el.ETab.Text = ('{0}月{1}日 周{2}' -f $d.Month, $d.Day, '日一二三四五六'[[int]$d.DayOfWeek])
  $el.ETime.Text = $(if ($null -ne $s.left) { Format-Clock $s.left } else { Format-Clock $s.planned })
  $el.EBar.Width = [Math]::Max(0, 214 * $s.progress)
  $running = $s.open -and $s.open.state -eq 'running'
  # 播放键：空闲 ▶ 开始 / 专注中 ⏸ / 暂停时 ▶ 继续
  $el.BtnToggle.Content = [string][char]$(if ($running) { 0xE769 } else { 0xE768 })
  $el.BtnToggle.ToolTip = $(if (-not $s.open) { "开始 $([Math]::Ceiling($s.planned / 60)) 分钟" } elseif ($running) { '暂停' } else { '继续' })
  $el.BtnToggle.IsEnabled = [bool](-not $state.error -and ($s.open -or $s.taskId))
  $el.BtnFinish.IsEnabled = [bool]$s.open
  $el.BtnDone.IsEnabled = [bool]($s.taskId -and -not $state.error)
  Set-Face $(if ($paused) { 'flat' } elseif ($state.error) { 'flat' } else { 'smile' }) $running
}

# 表情：嘴型（微笑 / 放平），专注中整张脸轻轻上下呼吸
$faceMood = ''
function Set-Face([string]$mood, [bool]$breathe) {
  if ($mood -ne $script:faceMood) {
    $script:faceMood = $mood
    $el.Mouth.Data = [Windows.Media.Geometry]::Parse($(if ($mood -eq 'smile') { 'M 72,60 Q 85,72 98,60' } else { 'M 73,64 L 97,64' }))
  }
  if ($breathe -ne $state.breathing) {
    $state.breathing = $breathe
    if ($breathe) {
      $a = New-Object Windows.Media.Animation.DoubleAnimation(0, -4, [TimeSpan]::FromMilliseconds(1600))
      $a.AutoReverse = $true; $a.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
      $e = New-Object Windows.Media.Animation.SineEase; $e.EasingMode = 'EaseInOut'; $a.EasingFunction = $e
      $el.FaceShift.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $a)
    } else {
      $el.FaceShift.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $null)
    }
  }
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
  $w = if ($on) { 640 } else { 236 }; $h = if ($on) { 262 } else { 38 }; $r = if ($on) { 36 } else { 19 }
  $el.Island.BeginAnimation([Windows.FrameworkElement]::WidthProperty, (Animate $null $w 420 0.32))
  $el.Island.BeginAnimation([Windows.FrameworkElement]::HeightProperty, (Animate $null $h 420 0.32))
  foreach ($b in $el.DarkBg, $el.GlassBg) { $b.CornerRadius = New-Object Windows.CornerRadius($r) }
  $glass = New-Object Windows.Media.Animation.DoubleAnimation($(if ($on) { 1 } else { 0 }), [TimeSpan]::FromMilliseconds(320))
  $dark = New-Object Windows.Media.Animation.DoubleAnimation($(if ($on) { 0 } else { 1 }), [TimeSpan]::FromMilliseconds(320))
  $el.GlassBg.BeginAnimation([Windows.UIElement]::OpacityProperty, $glass)
  $el.DarkBg.BeginAnimation([Windows.UIElement]::OpacityProperty, $dark)
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
$el.Island.Add_MouseLeave({ if (-not $Expanded -and -not $state.pinned) { $collapseTimer.Start() } })

# 拖动：按住岛身任意空白处
$el.Island.Add_MouseLeftButtonDown({ param($s, $e)
  $node = $e.OriginalSource
  while ($node -and $node -isnot [Windows.Controls.Button] -and $node -ne $el.Island) {
    $node = if ($node -is [Windows.Media.Visual]) { [Windows.Media.VisualTreeHelper]::GetParent($node) } else { $null }
  }
  if ($node -isnot [Windows.Controls.Button]) { try { $win.DragMove() } catch {} }
})

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
      # 开始时的任务和时长与岛上显示的一致：有当前计划就按计划（到时间块结束），否则推荐任务 25 分钟
      $s = Get-Snapshot
      Send-Command @{ type = 'startFocus'; id = 'focus-' + [guid]::NewGuid().ToString(); taskId = $s.taskId; plannedSeconds = [int]$s.planned }
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
$el.QOpen.Add_Click({ Start-Process "$base/" })
# 固定展开：鼠标移开也不收起（Wisland 的「悬停展开」开关）
$el.QPin.Add_Click({
  $state.pinned = -not $state.pinned
  $el.QPinIcon.Text = [string][char]$(if ($state.pinned) { 0xE840 } else { 0xE718 })
  $el.QPinText.Text = $(if ($state.pinned) { '取消固定' } else { '固定展开' })
})
$el.QFold.Add_Click({ $state.pinned = $false; $el.QPinIcon.Text = [string][char]0xE718; $el.QPinText.Text = '固定展开'; $collapseTimer.Stop(); Set-Expanded $false })
$el.QClose.Add_Click({ $win.Close() })

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

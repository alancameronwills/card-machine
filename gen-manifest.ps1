Get-ChildItem -Path . -Recurse -Attributes !Directory |
Sort FullName |
Format-Table -Property LastWriteTime,  @{Label="Name";
	 Expression={$_.FullName -replace('^.*\\card-machine\\','')}
 } | 
 out-string -stream |
 % {$_ -replace(" +$","") -replace("\\", "/") -replace('^([0-9/]+) ([0-9:]+) (.*)$', '$1T$2 $3') } |
 Select-String -NotMatch '^\W*$', 'LastWriteTime', '----', 'node_modules', '\.ps1$', 'cred-', '\.\.', 'package' |
 out-file -encoding ASCII manifest.txt
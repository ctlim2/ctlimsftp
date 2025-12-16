<?php



ini_set('display_errors', 1);
error_reporting(E_ALL);



include_once "/data/webdocs/wcms/classes/class_autoload_comm.php";




$startTime = microtime(1);

$conf = new Configure();
$cf   = $conf->readConfig("database");
$path = $conf->readConfig("path");
//$db   = new MySQL("192.168.0.62", "root", "a181828");
//$ret = Lib::backtrace_to_string(null, 0);

echo "<pre>";
//echo $file."\n";
  
//echo "\nisfile : ".$file." : ".$ret."\n";

for($i=0; $i<10; $i++) {
  clearstatcache();
  $ret = "false";

  $file = "/data/webdocs/seoul/www//////xml/2025/09/17/20250917500133.xml";

  $file = preg_replace('#/+#', '/', $file);


  if(is_file($file)==true) $ret = "true";
  else  $ret = "false";
  echo "$i : $ret \n";
}

?>

if test ! -d ~/src/card-machine ;
then 
	mkdir ~/src
	cd ~/src
	git clone https://github.com/alancameronwills/card-machine.git
fi


(  cd ~/src/card-machine
   git fetch --all &&
   git reset --hard origin/master ) &&
cp -ruv ~/src/card-machine/* ~/card-machine

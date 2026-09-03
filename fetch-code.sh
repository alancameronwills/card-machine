{
	echo
	date
	if test ! -d ~/src/card-machine ;
	then 
		git=`sed -n "/\"code\"/s/^[^:]*: \"\([^\"]*\).*/\1/p" <~/cred-*/*.config`
		mkdir ~/src
		cd ~/src
		git clone ${git:-https://github.com/alancameronwills/card-machine.git}
	fi

	cd ~/src/card-machine
	git fetch -q --all &&
	git reset --hard origin/master > log-src-version.log
	cat log-src-version.log
} >> log-update.log 2>&1